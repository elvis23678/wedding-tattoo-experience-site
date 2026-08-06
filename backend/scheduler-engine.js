
import crypto from 'node:crypto';
import {
  SCHEDULER_JOB_NAMES,
  schedulerConfigFromEnv,
  schedulerIntervalMs,
  schedulerRuleSummary
} from './scheduler-rules.js';

const SYSTEM_ACTOR = Object.freeze({
  type: 'scheduler',
  id: 'wte-scheduler',
  name: 'Scheduler WTE'
});

function schedulerError(message, code = 'SCHEDULER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dateOnly(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function uniqueToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function createSchedulerEngine({
  pool,
  workflow,
  env = process.env,
  logger = console,
  onGuestFinalized = null,
  onCycleCompleted = null,
  onDocumentReady = null
}) {
  if (!pool?.query || !pool?.connect) {
    throw schedulerError('Pool PostgreSQL mancante.');
  }
  if (!workflow?.sync || !workflow?.transition) {
    throw schedulerError('Workflow Engine mancante.');
  }

  const config = schedulerConfigFromEnv(env);
  const instanceId =
    String(env.RENDER_INSTANCE_ID || env.HOSTNAME || '').trim()
    || `local-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  let timer = null;
  let running = false;

  async function startRun(jobName, trigger = 'scheduled') {
    const result = await pool.query(
      `INSERT INTO wte_scheduler_runs
       (job_name,instance_id,trigger,status,started_at)
       VALUES ($1,$2,$3,'running',NOW())
       RETURNING id`,
      [jobName, instanceId, trigger]
    );
    return result.rows[0].id;
  }

  async function finishRun(runId, status, details = {}, error = '') {
    await pool.query(
      `UPDATE wte_scheduler_runs
       SET status=$2,
           finished_at=NOW(),
           details=$3::jsonb,
           error=$4
       WHERE id=$1`,
      [runId, status, JSON.stringify(details || {}), String(error || '').slice(0, 4000)]
    );
  }

  async function recordItem({
    runId,
    jobName,
    practiceId = null,
    result,
    details = {},
    error = ''
  }) {
    await pool.query(
      `INSERT INTO wte_scheduler_run_items
       (run_id,job_name,practice_id,result,details,error)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        runId,
        jobName,
        practiceId,
        result,
        JSON.stringify(details || {}),
        String(error || '').slice(0, 4000)
      ]
    );
  }

  async function withAdvisoryLock(handler) {
    const client = await pool.connect();
    const lockKey = 947_411_204;

    try {
      const lock = await client.query(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [lockKey]
      );
      if (!lock.rows[0]?.acquired) {
        return { skipped: true, reason: 'another_instance_is_running' };
      }

      try {
        return await handler();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      }
    } finally {
      client.release();
    }
  }

  async function safeWorkflowSync(practiceId, reason) {
    try {
      return await workflow.sync(practiceId, {
        actor: SYSTEM_ACTOR,
        reason
      });
    } catch (error) {
      logger.error(`[SCHEDULER] Sync ${practiceId} fallita`, error);
      throw error;
    }
  }

  async function safeTransition(practiceId, toState, reason, payload = {}) {
    const state = await workflow.getState(practiceId);
    if (!state) throw schedulerError(`Workflow ${practiceId} non trovato.`);

    if (state.current_state === toState) {
      return { changed: false, state };
    }

    try {
      return await workflow.transition(practiceId, toState, {
        actor: SYSTEM_ACTOR,
        reason,
        payload,
        eventKey: `scheduler:${practiceId}:${toState}:${reason}`,
        expectedVersion: state.version
      });
    } catch (error) {
      if (error.code === 'INVALID_WORKFLOW_TRANSITION') {
        return safeWorkflowSync(practiceId, `${reason}_sync_fallback`);
      }
      throw error;
    }
  }

  async function workflowSyncJob(runId) {
    const result = await pool.query(
      `SELECT id
       FROM wte_practices
       ORDER BY updated_at ASC
       LIMIT $1`,
      [config.batchSize]
    );

    let changed = 0;
    let unchanged = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        const synced = await safeWorkflowSync(row.id, 'scheduler_periodic_sync');
        synced.changed ? changed++ : unchanged++;
        await recordItem({
          runId,
          jobName: 'workflow_sync',
          practiceId: row.id,
          result: synced.changed ? 'changed' : 'unchanged',
          details: {
            state: synced.state?.current_state || synced.inferredState || null
          }
        });
      } catch (error) {
        failed++;
        await recordItem({
          runId,
          jobName: 'workflow_sync',
          practiceId: row.id,
          result: 'failed',
          error: error.message
        });
      }
    }

    return {
      scanned: result.rowCount,
      changed,
      unchanged,
      failed
    };
  }

  async function guestActivationJob(runId) {
    const result = await pool.query(
      `SELECT p.id AS practice_id,p.data
       FROM wte_practices p
       JOIN wte_payment_plans pp ON pp.practice_id=p.id
       LEFT JOIN wte_guest_events ge ON ge.practice_id=p.id
       WHERE pp.deposit_status='paid'
         AND ge.practice_id IS NULL
         AND p.data->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND (p.data->>'date')::date >
             CURRENT_DATE + $1::int
       ORDER BY (p.data->>'date')::date ASC
       LIMIT $2`,
      [config.guestCloseDaysBeforeEvent, config.batchSize]
    );

    let created = 0;
    let failed = 0;

    for (const row of result.rows) {
      const eventDate = dateOnly(row.data?.date);
      if (!eventDate) continue;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await client.query(
          'SELECT token FROM wte_guest_events WHERE practice_id=$1 FOR UPDATE',
          [row.practice_id]
        );
        if (existing.rowCount) {
          await client.query('COMMIT');
          continue;
        }

        const token = uniqueToken();
        const inserted = await client.query(
          `INSERT INTO wte_guest_events
           (token,practice_id,event_date,closes_at,max_flash,status)
           VALUES (
             $1,$2,$3::date,
             (($3::date - $4::int) AT TIME ZONE 'Europe/Rome'),
             50,'open'
           )
           RETURNING token,event_date,closes_at,status`,
          [
            token,
            row.practice_id,
            eventDate,
            config.guestCloseDaysBeforeEvent
          ]
        );

        const guest = inserted.rows[0];
        const publicUrl =
          `https://www.weddingtattooexperience.it/guest-flash.html?token=${token}`;
        const qrUrl =
          `https://wte-cloud-api.onrender.com/api/public/guest-event/${token}/qr.svg`;

        await client.query(
          `UPDATE wte_practices
           SET data=jsonb_set(
             COALESCE(data,'{}'::jsonb),
             '{guestVoting}',
             $2::jsonb,
             TRUE
           ),
           updated_at=NOW()
           WHERE id=$1`,
          [
            row.practice_id,
            JSON.stringify({
              token,
              status: 'open',
              eventDate,
              closesAt: guest.closes_at,
              publicUrl,
              qrUrl
            })
          ]
        );

        await client.query('COMMIT');

        await safeTransition(
          row.practice_id,
          'guest_selection',
          'scheduler_guest_catalog_opened',
          {
            token,
            closesAt: guest.closes_at,
            publicUrl,
            qrUrl
          }
        );

        created++;
        await recordItem({
          runId,
          jobName: 'guest_activation',
          practiceId: row.practice_id,
          result: 'created',
          details: {
            token,
            closesAt: guest.closes_at
          }
        });
      } catch (error) {
        await client.query('ROLLBACK');
        failed++;
        await recordItem({
          runId,
          jobName: 'guest_activation',
          practiceId: row.practice_id,
          result: 'failed',
          error: error.message
        });
      } finally {
        client.release();
      }
    }

    return {
      candidates: result.rowCount,
      created,
      failed
    };
  }

  async function finalizeGuestEvent(practiceId, token, maxFlash) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query(
        `SELECT token,status,closes_at
         FROM wte_guest_events
         WHERE token=$1
         FOR UPDATE`,
        [token]
      );
      if (!locked.rowCount) {
        throw schedulerError('Evento invitati non trovato.');
      }
      if (locked.rows[0].status === 'finalized') {
        await client.query('COMMIT');
        return { alreadyFinalized: true, finalCodes: [] };
      }

      const ranking = await client.query(
        `SELECT flash_code AS code,
                COUNT(*)::int AS votes,
                MIN(created_at) AS first_vote
         FROM wte_guest_votes
         WHERE event_token=$1
         GROUP BY flash_code
         ORDER BY votes DESC,first_vote ASC,flash_code ASC
         LIMIT $2`,
        [token, maxFlash]
      );
      const finalCodes = ranking.rows.map(row => row.code);

      await client.query(
        `UPDATE wte_guest_events
         SET status='finalized',
             final_codes=$2::jsonb,
             finalized_at=NOW(),
             updated_at=NOW()
         WHERE token=$1`,
        [token, JSON.stringify(finalCodes)]
      );

      const pdfUrl =
        `https://wte-cloud-api.onrender.com/api/guest-events/${token}/pdf`;

      await client.query(
        `UPDATE wte_practices
         SET data=jsonb_set(
           COALESCE(data,'{}'::jsonb),
           '{guestVoting}',
           $2::jsonb,
           TRUE
         ),
         updated_at=NOW()
         WHERE id=$1`,
        [
          practiceId,
          JSON.stringify({
            token,
            status: 'finalized',
            finalCodes,
            count: finalCodes.length,
            pdfUrl,
            finalizedAt: new Date().toISOString()
          })
        ]
      );

      await client.query('COMMIT');

      return {
        alreadyFinalized: false,
        finalCodes,
        pdfUrl
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function guestFinalizationJob(runId) {
    const result = await pool.query(
      `SELECT token,practice_id,max_flash,closes_at
       FROM wte_guest_events
       WHERE status='open'
         AND closes_at<=NOW()
       ORDER BY closes_at ASC
       LIMIT $1`,
      [config.batchSize]
    );

    let finalized = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        const output = await finalizeGuestEvent(
          row.practice_id,
          row.token,
          Number(row.max_flash || 50)
        );

        await safeTransition(
          row.practice_id,
          'guest_selection_closed',
          'scheduler_guest_deadline_reached',
          {
            token: row.token,
            closesAt: row.closes_at,
            finalCount: output.finalCodes.length
          }
        );

        await safeTransition(
          row.practice_id,
          'flash_pdf_ready',
          'scheduler_flash_pdf_ready',
          {
            token: row.token,
            pdfUrl: output.pdfUrl,
            finalCount: output.finalCodes.length
          }
        );

        if (typeof onDocumentReady === 'function') {
          await onDocumentReady({
            practiceId:row.practice_id,
            type:'flash_selection',
            url:output.pdfUrl,
            metadata:{
              finalCount:output.finalCodes.length,
              token:row.token
            }
          });
        }

        if (typeof onGuestFinalized === 'function') {
          await onGuestFinalized({
            practiceId: row.practice_id,
            token: row.token,
            finalCodes: output.finalCodes,
            pdfUrl: output.pdfUrl
          });
        }

        finalized++;
        await recordItem({
          runId,
          jobName: 'guest_finalization',
          practiceId: row.practice_id,
          result: output.alreadyFinalized ? 'already_finalized' : 'finalized',
          details: {
            token: row.token,
            finalCount: output.finalCodes.length,
            pdfUrl: output.pdfUrl
          }
        });
      } catch (error) {
        failed++;
        await recordItem({
          runId,
          jobName: 'guest_finalization',
          practiceId: row.practice_id,
          result: 'failed',
          error: error.message
        });
      }
    }

    return {
      due: result.rowCount,
      finalized,
      failed
    };
  }

  async function balanceDueJob(runId) {
    const result = await pool.query(
      `SELECT pp.practice_id,pp.balance_due_at,p.data
       FROM wte_payment_plans pp
       JOIN wte_practices p ON p.id=pp.practice_id
       WHERE pp.deposit_status='paid'
         AND pp.balance_status='pending'
         AND p.data->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND (p.data->>'date')::date - $1::int <= CURRENT_DATE
       ORDER BY (p.data->>'date')::date ASC
       LIMIT $2`,
      [config.balanceDueDaysBeforeEvent, config.batchSize]
    );

    let transitioned = 0;
    let unchanged = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        const state = await workflow.getState(row.practice_id);
        if (state?.current_state === 'balance_pending') {
          unchanged++;
        } else {
          const output = await safeTransition(
            row.practice_id,
            'balance_pending',
            'scheduler_balance_window_opened',
            {
              dueAt: row.balance_due_at,
              daysBeforeEvent: config.balanceDueDaysBeforeEvent
            }
          );
          output.changed ? transitioned++ : unchanged++;
        }

        await recordItem({
          runId,
          jobName: 'balance_due',
          practiceId: row.practice_id,
          result: state?.current_state === 'balance_pending'
            ? 'unchanged'
            : 'transitioned',
          details: {
            balanceDueAt: row.balance_due_at
          }
        });
      } catch (error) {
        failed++;
        await recordItem({
          runId,
          jobName: 'balance_due',
          practiceId: row.practice_id,
          result: 'failed',
          error: error.message
        });
      }
    }

    return {
      due: result.rowCount,
      transitioned,
      unchanged,
      failed
    };
  }

  async function eventCompletionJob(runId) {
    const result = await pool.query(
      `SELECT pp.practice_id,p.data
       FROM wte_payment_plans pp
       JOIN wte_practices p ON p.id=pp.practice_id
       WHERE pp.balance_status='paid'
         AND p.data->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND (p.data->>'date')::date < CURRENT_DATE
       ORDER BY (p.data->>'date')::date ASC
       LIMIT $1`,
      [config.batchSize]
    );

    let completed = 0;
    let unchanged = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        const state = await workflow.getState(row.practice_id);

        if (state?.current_state === 'event_completed'
            || state?.current_state === 'archived') {
          unchanged++;
        } else {
          await safeTransition(
            row.practice_id,
            'event_completed',
            'scheduler_event_date_passed',
            { eventDate: row.data?.date || null }
          );
          completed++;
        }

        await recordItem({
          runId,
          jobName: 'event_completion',
          practiceId: row.practice_id,
          result: state?.current_state === 'event_completed'
            || state?.current_state === 'archived'
            ? 'unchanged'
            : 'completed',
          details: { eventDate: row.data?.date || null }
        });
      } catch (error) {
        failed++;
        await recordItem({
          runId,
          jobName: 'event_completion',
          practiceId: row.practice_id,
          result: 'failed',
          error: error.message
        });
      }
    }

    return {
      candidates: result.rowCount,
      completed,
      unchanged,
      failed
    };
  }

  async function archivalJob(runId) {
    const result = await pool.query(
      `SELECT ws.practice_id,p.data
       FROM wte_workflow_state ws
       JOIN wte_practices p ON p.id=ws.practice_id
       WHERE ws.current_state='event_completed'
         AND p.data->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND (p.data->>'date')::date + $1::int <= CURRENT_DATE
       ORDER BY (p.data->>'date')::date ASC
       LIMIT $2`,
      [config.archiveDaysAfterEvent, config.batchSize]
    );

    let archived = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        await safeTransition(
          row.practice_id,
          'archived',
          'scheduler_archive_delay_elapsed',
          {
            eventDate: row.data?.date || null,
            daysAfterEvent: config.archiveDaysAfterEvent
          }
        );

        await pool.query(
          `UPDATE wte_practices
           SET data=jsonb_set(
             COALESCE(data,'{}'::jsonb),
             '{archivedAt}',
             to_jsonb(NOW()::text),
             TRUE
           ),
           updated_at=NOW()
           WHERE id=$1`,
          [row.practice_id]
        );

        archived++;
        await recordItem({
          runId,
          jobName: 'practice_archival',
          practiceId: row.practice_id,
          result: 'archived',
          details: {
            eventDate: row.data?.date || null
          }
        });
      } catch (error) {
        failed++;
        await recordItem({
          runId,
          jobName: 'practice_archival',
          practiceId: row.practice_id,
          result: 'failed',
          error: error.message
        });
      }
    }

    return {
      candidates: result.rowCount,
      archived,
      failed
    };
  }

  const jobHandlers = Object.freeze({
    workflow_sync: workflowSyncJob,
    guest_activation: guestActivationJob,
    guest_finalization: guestFinalizationJob,
    balance_due: balanceDueJob,
    event_completion: eventCompletionJob,
    practice_archival: archivalJob
  });

  async function runJob(jobName, {
    trigger = 'manual'
  } = {}) {
    if (!SCHEDULER_JOB_NAMES.includes(jobName)) {
      throw schedulerError(`Job sconosciuto: ${jobName}`, 'UNKNOWN_JOB');
    }

    const runId = await startRun(jobName, trigger);

    try {
      const details = await jobHandlers[jobName](runId);
      await finishRun(runId, 'success', details);
      return {
        runId,
        jobName,
        status: 'success',
        details
      };
    } catch (error) {
      await finishRun(runId, 'failed', {}, error.message);
      throw error;
    }
  }

  async function runAll({
    trigger = 'scheduled'
  } = {}) {
    if (running) {
      return { skipped: true, reason: 'local_run_in_progress' };
    }
    running = true;

    try {
      return await withAdvisoryLock(async () => {
        const startedAt = new Date().toISOString();
        const jobs = {};

        for (const jobName of SCHEDULER_JOB_NAMES) {
          try {
            jobs[jobName] = await runJob(jobName, { trigger });
          } catch (error) {
            jobs[jobName] = {
              jobName,
              status: 'failed',
              error: error.message
            };
          }
        }

        const result={
          skipped:false,
          instanceId,
          startedAt,
          finishedAt:new Date().toISOString(),
          jobs
        };

        if(typeof onCycleCompleted==='function'){
          try{
            result.notificationDispatch=await onCycleCompleted(result);
          }catch(error){
            logger.error('[SCHEDULER] Notification dispatch fallita',error);
            result.notificationDispatch={
              status:'failed',
              error:error.message
            };
          }
        }

        return result;
      });
    } finally {
      running = false;
    }
  }

  async function recentRuns(limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const result = await pool.query(
      `SELECT id,job_name,instance_id,trigger,status,started_at,
              finished_at,details,error
       FROM wte_scheduler_runs
       ORDER BY id DESC
       LIMIT $1`,
      [safeLimit]
    );
    return result.rows;
  }

  async function runItems(runId, limit = 500) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
    const result = await pool.query(
      `SELECT id,run_id,job_name,practice_id,result,details,error,created_at
       FROM wte_scheduler_run_items
       WHERE run_id=$1
       ORDER BY id ASC
       LIMIT $2`,
      [runId, safeLimit]
    );
    return result.rows;
  }

  function start() {
    if (!config.enabled || timer) {
      return {
        started: false,
        enabled: config.enabled,
        reason: timer ? 'already_started' : 'disabled'
      };
    }

    const intervalMs = schedulerIntervalMs(config);
    timer = setInterval(() => {
      runAll({ trigger: 'scheduled' }).catch(error =>
        logger.error('[SCHEDULER] Esecuzione programmata fallita', error)
      );
    }, intervalMs);
    timer.unref?.();

    setTimeout(() => {
      runAll({ trigger: 'startup' }).catch(error =>
        logger.error('[SCHEDULER] Esecuzione iniziale fallita', error)
      );
    }, 12_000).unref?.();

    return {
      started: true,
      enabled: true,
      intervalMs
    };
  }

  function stop() {
    if (!timer) return { stopped: false };
    clearInterval(timer);
    timer = null;
    return { stopped: true };
  }

  function status() {
    return {
      enabled: config.enabled,
      running,
      timerActive: Boolean(timer),
      instanceId,
      config,
      rules: schedulerRuleSummary(config),
      jobs: SCHEDULER_JOB_NAMES
    };
  }

  return {
    config,
    jobs: SCHEDULER_JOB_NAMES,
    start,
    stop,
    status,
    runAll,
    runJob,
    recentRuns,
    runItems
  };
}
