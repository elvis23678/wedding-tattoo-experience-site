
import crypto from 'node:crypto';

export const WORKFLOW_STATES = Object.freeze([
  'new_request',
  'advisor_completed',
  'contract_ready',
  'contract_accepted',
  'deposit_pending',
  'deposit_paid',
  'guest_selection',
  'guest_selection_closed',
  'flash_pdf_ready',
  'balance_pending',
  'balance_paid',
  'event_ready',
  'event_completed',
  'archived',
  'cancelled'
]);

export const TERMINAL_WORKFLOW_STATES = Object.freeze([
  'archived',
  'cancelled'
]);

export const WORKFLOW_TRANSITIONS = Object.freeze({
  new_request: ['advisor_completed', 'cancelled'],
  advisor_completed: ['contract_ready', 'cancelled'],
  contract_ready: ['contract_accepted', 'cancelled'],
  contract_accepted: ['deposit_pending', 'cancelled'],
  deposit_pending: ['deposit_paid', 'cancelled'],
  deposit_paid: ['guest_selection', 'balance_pending', 'cancelled'],
  guest_selection: ['guest_selection_closed', 'cancelled'],
  guest_selection_closed: ['flash_pdf_ready', 'cancelled'],
  flash_pdf_ready: ['balance_pending', 'balance_paid', 'cancelled'],
  balance_pending: ['balance_paid', 'cancelled'],
  balance_paid: ['event_ready', 'cancelled'],
  event_ready: ['event_completed', 'cancelled'],
  event_completed: ['archived'],
  archived: [],
  cancelled: []
});

const ACTIONS_BY_STATE = Object.freeze({
  advisor_completed: ['prepare_contract'],
  contract_ready: ['expose_contract'],
  contract_accepted: ['create_payment_plan'],
  deposit_pending: ['request_deposit'],
  deposit_paid: [
    'activate_couple_area',
    'create_guest_qr',
    'generate_deposit_receipt'
  ],
  guest_selection: ['open_guest_catalog'],
  guest_selection_closed: ['lock_guest_catalog', 'calculate_top_flash'],
  flash_pdf_ready: ['attach_flash_pdf', 'prepare_event_bundle'],
  balance_pending: ['request_balance'],
  balance_paid: ['mark_payments_complete', 'generate_balance_receipt'],
  event_ready: ['prepare_event_bundle'],
  event_completed: ['close_event'],
  archived: ['archive_practice'],
  cancelled: ['cancel_pending_actions']
});

function assertState(state) {
  if (!WORKFLOW_STATES.includes(state)) {
    throw new Error(`Stato workflow non valido: ${state}`);
  }
}

function normalizeActor(actor = {}) {
  return {
    type: String(actor.type || 'system').slice(0, 40),
    id: actor.id == null ? null : String(actor.id).slice(0, 180),
    name: String(actor.name || 'Sistema').slice(0, 180)
  };
}

function stableEventKey(practiceId, fromState, toState, reason, requestedKey = '') {
  if (requestedKey) return String(requestedKey).slice(0, 240);
  return crypto
    .createHash('sha256')
    .update([
      practiceId,
      fromState || '',
      toState,
      reason || '',
      Date.now(),
      crypto.randomBytes(8).toString('hex')
    ].join('|'))
    .digest('hex');
}

function workflowError(message, statusCode = 400, code = 'WORKFLOW_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function createWorkflowEngine({
  pool,
  onTransition = null,
  logger = console
}) {
  if (!pool?.query) {
    throw new Error('Workflow Engine: pool PostgreSQL mancante.');
  }

  async function getPracticeSnapshot(client, practiceId) {
    const [practiceResult, paymentResult, guestResult, contractResult] =
      await Promise.all([
        client.query(
          'SELECT id,data,updated_at FROM wte_practices WHERE id=$1',
          [practiceId]
        ),
        client.query(
          `SELECT deposit_status,balance_status,deposit_due_at,balance_due_at,
                  booking_status
           FROM wte_payment_plans WHERE practice_id=$1`,
          [practiceId]
        ),
        client.query(
          `SELECT status,closes_at,final_codes,finalized_at
           FROM wte_guest_events WHERE practice_id=$1`,
          [practiceId]
        ),
        client.query(
          `SELECT status,accepted_at,contract_number
           FROM wte_contracts WHERE practice_id=$1
           ORDER BY created_at DESC LIMIT 1`,
          [practiceId]
        )
      ]);

    if (!practiceResult.rowCount) {
      throw workflowError('Pratica non trovata.', 404, 'PRACTICE_NOT_FOUND');
    }

    return {
      practice: practiceResult.rows[0],
      data: practiceResult.rows[0].data || {},
      payment: paymentResult.rows[0] || null,
      guest: guestResult.rows[0] || null,
      contract: contractResult.rows[0] || null
    };
  }

  function inferState(snapshot) {
    const { data, payment, guest, contract } = snapshot;
    const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))
      ? new Date(`${data.date}T23:59:59+02:00`)
      : null;
    const eventIsPast = eventDate ? eventDate < new Date() : false;

    if (String(data.status || '').toLowerCase().includes('annull')) {
      return 'cancelled';
    }
    if (String(data.workflowState || '') === 'archived') {
      return 'archived';
    }
    if (eventIsPast && payment?.balance_status === 'paid') {
      return 'event_completed';
    }
    if (payment?.deposit_status === 'paid' && payment?.balance_status === 'paid') {
      return 'event_ready';
    }
    if (payment?.balance_status === 'paid') {
      return 'balance_paid';
    }
    if (guest?.status === 'finalized') {
      const finalCodes = Array.isArray(guest.final_codes) ? guest.final_codes : [];
      return finalCodes.length ? 'flash_pdf_ready' : 'guest_selection_closed';
    }
    if (payment?.deposit_status === 'paid' && guest?.status === 'open') {
      return 'guest_selection';
    }
    if (payment?.deposit_status === 'paid') {
      return 'deposit_paid';
    }
    if (payment && payment.deposit_status === 'pending') {
      return 'deposit_pending';
    }
    if (contract?.status === 'accepted' || data.contract?.status === 'accepted') {
      return 'contract_accepted';
    }
    if (contract?.status === 'draft' || data.contract?.token) {
      return 'contract_ready';
    }
    if (data.packageCode || data.package || data.source === 'advisor-v3') {
      return 'advisor_completed';
    }
    return 'new_request';
  }

  async function ensureState(practiceId, {
    actor = { type: 'system', name: 'Sistema' },
    reason = 'workflow_initialized'
  } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT practice_id,current_state,version,entered_at,updated_at,metadata
         FROM wte_workflow_state
         WHERE practice_id=$1
         FOR UPDATE`,
        [practiceId]
      );

      if (existing.rowCount) {
        await client.query('COMMIT');
        return existing.rows[0];
      }

      const snapshot = await getPracticeSnapshot(client, practiceId);
      const inferred = inferState(snapshot);
      const normalizedActor = normalizeActor(actor);

      const inserted = await client.query(
        `INSERT INTO wte_workflow_state
         (practice_id,current_state,version,entered_at,metadata)
         VALUES ($1,$2,1,NOW(),$3::jsonb)
         RETURNING practice_id,current_state,version,entered_at,updated_at,metadata`,
        [
          practiceId,
          inferred,
          JSON.stringify({ initializedFrom: 'practice_snapshot' })
        ]
      );

      await client.query(
        `INSERT INTO wte_workflow_history
         (event_key,practice_id,from_state,to_state,reason,
          actor_type,actor_id,actor_name,payload)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          stableEventKey(practiceId, '', inferred, reason),
          practiceId,
          inferred,
          reason,
          normalizedActor.type,
          normalizedActor.id,
          normalizedActor.name,
          JSON.stringify({ inferred: true })
        ]
      );

      await client.query(
        `UPDATE wte_practices
         SET data=jsonb_set(
           COALESCE(data,'{}'::jsonb),
           '{workflowState}',
           to_jsonb($2::text),
           TRUE
         ),
         updated_at=NOW()
         WHERE id=$1`,
        [practiceId, inferred]
      );

      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getState(practiceId) {
    await ensureState(practiceId);
    const result = await pool.query(
      `SELECT practice_id,current_state,version,entered_at,updated_at,metadata
       FROM wte_workflow_state WHERE practice_id=$1`,
      [practiceId]
    );
    return result.rows[0] || null;
  }

  async function enqueueActions(client, {
    practiceId,
    state,
    transitionId,
    payload = {}
  }) {
    const actions = ACTIONS_BY_STATE[state] || [];
    for (const actionType of actions) {
      const actionKey = `${transitionId}:${actionType}`;
      await client.query(
        `INSERT INTO wte_workflow_action_queue
         (action_key,practice_id,transition_id,action_type,status,payload)
         VALUES ($1,$2,$3,$4,'pending',$5::jsonb)
         ON CONFLICT (action_key) DO NOTHING`,
        [
          actionKey,
          practiceId,
          transitionId,
          actionType,
          JSON.stringify(payload)
        ]
      );
    }
    return actions;
  }

  async function transition(practiceId, toState, {
    reason = 'manual_transition',
    actor = { type: 'system', name: 'Sistema' },
    payload = {},
    eventKey = '',
    expectedVersion = null,
    force = false
  } = {}) {
    assertState(toState);
    const normalizedActor = normalizeActor(actor);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await getPracticeSnapshot(client, practiceId);

      let currentResult = await client.query(
        `SELECT practice_id,current_state,version,metadata
         FROM wte_workflow_state
         WHERE practice_id=$1
         FOR UPDATE`,
        [practiceId]
      );

      if (!currentResult.rowCount) {
        await client.query('ROLLBACK');
        await ensureState(practiceId, { actor, reason: 'transition_initialization' });
        return transition(practiceId, toState, {
          reason, actor, payload, eventKey, expectedVersion, force
        });
      }

      const current = currentResult.rows[0];
      const fromState = current.current_state;

      if (fromState === toState) {
        await client.query('COMMIT');
        return {
          changed: false,
          state: current,
          transition: null,
          actions: []
        };
      }

      if (expectedVersion != null && Number(expectedVersion) !== Number(current.version)) {
        throw workflowError(
          'La pratica è stata aggiornata da un altro processo. Ricarica e riprova.',
          409,
          'WORKFLOW_VERSION_CONFLICT'
        );
      }

      const allowed = WORKFLOW_TRANSITIONS[fromState] || [];
      if (!force && !allowed.includes(toState)) {
        throw workflowError(
          `Transizione non consentita: ${fromState} → ${toState}.`,
          409,
          'INVALID_WORKFLOW_TRANSITION'
        );
      }

      const transitionEventKey = stableEventKey(
        practiceId, fromState, toState, reason, eventKey
      );

      const duplicate = await client.query(
        `SELECT id,from_state,to_state,created_at
         FROM wte_workflow_history WHERE event_key=$1`,
        [transitionEventKey]
      );
      if (duplicate.rowCount) {
        await client.query('COMMIT');
        return {
          changed: false,
          duplicate: true,
          state: current,
          transition: duplicate.rows[0],
          actions: []
        };
      }

      const updated = await client.query(
        `UPDATE wte_workflow_state
         SET current_state=$2,
             version=version+1,
             entered_at=NOW(),
             updated_at=NOW(),
             metadata=COALESCE(metadata,'{}'::jsonb) || $3::jsonb
         WHERE practice_id=$1
         RETURNING practice_id,current_state,version,entered_at,updated_at,metadata`,
        [
          practiceId,
          toState,
          JSON.stringify({
            lastReason: reason,
            lastActor: normalizedActor.name
          })
        ]
      );

      const history = await client.query(
        `INSERT INTO wte_workflow_history
         (event_key,practice_id,from_state,to_state,reason,
          actor_type,actor_id,actor_name,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         RETURNING id,event_key,practice_id,from_state,to_state,reason,
                   actor_type,actor_id,actor_name,payload,created_at`,
        [
          transitionEventKey,
          practiceId,
          fromState,
          toState,
          reason,
          normalizedActor.type,
          normalizedActor.id,
          normalizedActor.name,
          JSON.stringify(payload || {})
        ]
      );

      await client.query(
        `UPDATE wte_practices
         SET data=jsonb_set(
           jsonb_set(
             COALESCE(data,'{}'::jsonb),
             '{workflowState}',
             to_jsonb($2::text),
             TRUE
           ),
           '{workflowUpdatedAt}',
           to_jsonb(NOW()::text),
           TRUE
         ),
         updated_at=NOW()
         WHERE id=$1`,
        [practiceId, toState]
      );

      const actions = await enqueueActions(client, {
        practiceId,
        state: toState,
        transitionId: history.rows[0].id,
        payload
      });

      await client.query('COMMIT');

      const result = {
        changed: true,
        state: updated.rows[0],
        transition: history.rows[0],
        actions
      };

      if (typeof onTransition === 'function') {
        Promise.resolve(onTransition(result)).catch(error =>
          logger.error('Workflow onTransition error', error)
        );
      }

      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function sync(practiceId, {
    actor = { type: 'system', name: 'Sistema' },
    reason = 'snapshot_sync'
  } = {}) {
    const current = await ensureState(practiceId, { actor });
    const client = await pool.connect();
    let inferred;

    try {
      const snapshot = await getPracticeSnapshot(client, practiceId);
      inferred = inferState(snapshot);
    } finally {
      client.release();
    }

    if (current.current_state === inferred) {
      return {
        changed: false,
        state: current,
        inferredState: inferred,
        actions: []
      };
    }

    const directAllowed =
      (WORKFLOW_TRANSITIONS[current.current_state] || []).includes(inferred);

    return transition(practiceId, inferred, {
      reason,
      actor,
      payload: { inferredFromSnapshot: true },
      force: !directAllowed
    });
  }

  async function history(practiceId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const result = await pool.query(
      `SELECT id,event_key,practice_id,from_state,to_state,reason,
              actor_type,actor_id,actor_name,payload,created_at
       FROM wte_workflow_history
       WHERE practice_id=$1
       ORDER BY id DESC
       LIMIT $2`,
      [practiceId, safeLimit]
    );
    return result.rows;
  }

  async function pendingActions(practiceId = null, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const params = [];
    let where = '';

    if (practiceId) {
      params.push(practiceId);
      where = 'WHERE practice_id=$1';
    }
    params.push(safeLimit);

    const result = await pool.query(
      `SELECT id,action_key,practice_id,transition_id,action_type,status,
              attempts,last_error,available_at,locked_at,payload,
              created_at,updated_at
       FROM wte_workflow_action_queue
       ${where}
       ORDER BY
         CASE status WHEN 'failed' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
         created_at ASC
       LIMIT $${params.length}`,
      params
    );
    return result.rows;
  }

  async function markAction(actionId, status, {
    error = '',
    result = {}
  } = {}) {
    if (!['processing', 'completed', 'failed', 'cancelled'].includes(status)) {
      throw workflowError('Stato azione non valido.');
    }

    const query = status === 'processing'
      ? `UPDATE wte_workflow_action_queue
         SET status='processing',locked_at=NOW(),attempts=attempts+1,
             updated_at=NOW()
         WHERE id=$1
         RETURNING *`
      : `UPDATE wte_workflow_action_queue
         SET status=$2,locked_at=NULL,last_error=$3,
             result=$4::jsonb,updated_at=NOW()
         WHERE id=$1
         RETURNING *`;

    const params = status === 'processing'
      ? [actionId]
      : [actionId, status, String(error || '').slice(0, 2000), JSON.stringify(result)];

    const updated = await pool.query(query, params);
    if (!updated.rowCount) {
      throw workflowError('Azione workflow non trovata.', 404, 'ACTION_NOT_FOUND');
    }
    return updated.rows[0];
  }

  async function list({
    state = '',
    limit = 100,
    offset = 0
  } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const params = [];
    let where = '';

    if (state) {
      assertState(state);
      params.push(state);
      where = 'WHERE ws.current_state=$1';
    }

    params.push(safeLimit, safeOffset);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;

    const result = await pool.query(
      `SELECT ws.practice_id,ws.current_state,ws.version,ws.entered_at,
              ws.updated_at,ws.metadata,p.data
       FROM wte_workflow_state ws
       JOIN wte_practices p ON p.id=ws.practice_id
       ${where}
       ORDER BY ws.updated_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    );
    return result.rows;
  }

  return {
    states: WORKFLOW_STATES,
    transitions: WORKFLOW_TRANSITIONS,
    ensureState,
    getState,
    transition,
    sync,
    history,
    pendingActions,
    markAction,
    list,
    inferState
  };
}
