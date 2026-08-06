
import crypto from 'node:crypto';

function releaseError(message, code = 'RELEASE_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function createReleaseManager({
  pool,
  env = process.env,
  logger = console
}) {
  if (!pool?.query || !pool?.connect) {
    throw new Error('Release Manager: pool PostgreSQL mancante.');
  }

  const configuredRelease = String(env.WTE_RELEASE || '1.0.0');
  const deploymentId =
    String(env.RENDER_GIT_COMMIT || env.RENDER_SERVICE_ID || '').trim() ||
    crypto.randomBytes(8).toString('hex');

  async function current() {
    const result = await pool.query(
      `SELECT release_name,maintenance_enabled,maintenance_message,
              booking_enabled,updated_by,updated_at,metadata
       FROM wte_release_control
       WHERE id=1`
    );

    if (!result.rowCount) {
      const inserted = await pool.query(
        `INSERT INTO wte_release_control
         (id,release_name,maintenance_enabled,maintenance_message,
          booking_enabled,updated_by,metadata)
         VALUES (1,$1,FALSE,'',TRUE,'system',$2::jsonb)
         RETURNING release_name,maintenance_enabled,maintenance_message,
                   booking_enabled,updated_by,updated_at,metadata`,
        [
          configuredRelease,
          JSON.stringify({ deploymentId })
        ]
      );
      return inserted.rows[0];
    }

    return result.rows[0];
  }

  async function update({
    maintenanceEnabled,
    maintenanceMessage = '',
    bookingEnabled,
    releaseName = '',
    updatedBy = 'admin',
    metadata = {}
  }) {
    const currentState = await current();

    const nextMaintenance =
      typeof maintenanceEnabled === 'boolean'
        ? maintenanceEnabled
        : currentState.maintenance_enabled;

    const nextBooking =
      typeof bookingEnabled === 'boolean'
        ? bookingEnabled
        : currentState.booking_enabled;

    const result = await pool.query(
      `UPDATE wte_release_control
       SET release_name=COALESCE(NULLIF($1,''),release_name),
           maintenance_enabled=$2,
           maintenance_message=$3,
           booking_enabled=$4,
           updated_by=$5,
           metadata=metadata || $6::jsonb,
           updated_at=NOW()
       WHERE id=1
       RETURNING release_name,maintenance_enabled,maintenance_message,
                 booking_enabled,updated_by,updated_at,metadata`,
      [
        String(releaseName || '').slice(0, 80),
        nextMaintenance,
        String(maintenanceMessage || '').slice(0, 500),
        nextBooking,
        String(updatedBy || 'admin').slice(0, 180),
        JSON.stringify({
          deploymentId,
          ...metadata
        })
      ]
    );

    return result.rows[0];
  }

  async function setMaintenance(enabled, {
    message = '',
    updatedBy = 'admin'
  } = {}) {
    return update({
      maintenanceEnabled: Boolean(enabled),
      maintenanceMessage: message,
      bookingEnabled: !enabled,
      updatedBy,
      metadata: {
        maintenanceChangedAt: new Date().toISOString()
      }
    });
  }

  async function setBooking(enabled, {
    updatedBy = 'admin'
  } = {}) {
    return update({
      bookingEnabled: Boolean(enabled),
      updatedBy,
      metadata: {
        bookingChangedAt: new Date().toISOString()
      }
    });
  }

  async function assertBookingAllowed() {
    const state = await current();

    if (state.maintenance_enabled) {
      throw releaseError(
        state.maintenance_message ||
          'Il servizio è temporaneamente in manutenzione.',
        'MAINTENANCE_MODE',
        503
      );
    }

    if (!state.booking_enabled) {
      throw releaseError(
        'Le nuove prenotazioni sono temporaneamente sospese.',
        'BOOKING_DISABLED',
        503
      );
    }

    return state;
  }

  async function registerDeployment({
    releaseName = configuredRelease,
    commit = '',
    environment = env.NODE_ENV || 'production',
    notes = ''
  } = {}) {
    const result = await pool.query(
      `INSERT INTO wte_release_deployments
       (release_name,deployment_id,commit_hash,environment,status,notes)
       VALUES ($1,$2,$3,$4,'active',$5)
       RETURNING *`,
      [
        releaseName,
        deploymentId,
        String(commit || env.RENDER_GIT_COMMIT || '').slice(0, 120),
        String(environment || '').slice(0, 80),
        String(notes || '').slice(0, 1000)
      ]
    );

    await pool.query(
      `UPDATE wte_release_deployments
       SET status='superseded',updated_at=NOW()
       WHERE id<>$1 AND status='active'`,
      [result.rows[0].id]
    );

    await update({
      releaseName,
      updatedBy: 'deployment',
      metadata: {
        deploymentId,
        commit: String(commit || env.RENDER_GIT_COMMIT || '')
      }
    });

    return result.rows[0];
  }

  async function deployments(limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

    const result = await pool.query(
      `SELECT id,release_name,deployment_id,commit_hash,environment,
              status,notes,created_at,updated_at
       FROM wte_release_deployments
       ORDER BY id DESC
       LIMIT $1`,
      [safeLimit]
    );

    return result.rows;
  }

  async function markRollback({
    targetDeploymentId,
    updatedBy = 'admin',
    notes = ''
  }) {
    if (!targetDeploymentId) {
      throw releaseError(
        'Deployment di destinazione mancante.',
        'ROLLBACK_TARGET_MISSING'
      );
    }

    const target = await pool.query(
      `SELECT *
       FROM wte_release_deployments
       WHERE deployment_id=$1 OR id::text=$1
       ORDER BY id DESC
       LIMIT 1`,
      [String(targetDeploymentId)]
    );

    if (!target.rowCount) {
      throw releaseError(
        'Deployment non trovato.',
        'ROLLBACK_TARGET_NOT_FOUND',
        404
      );
    }

    const rollback = await pool.query(
      `INSERT INTO wte_release_rollbacks
       (target_deployment_id,target_release,requested_by,status,notes)
       VALUES ($1,$2,$3,'requested',$4)
       RETURNING *`,
      [
        target.rows[0].deployment_id,
        target.rows[0].release_name,
        String(updatedBy || 'admin').slice(0, 180),
        String(notes || '').slice(0, 1000)
      ]
    );

    logger.warn(
      `[RELEASE] Rollback richiesto verso ${target.rows[0].deployment_id}`
    );

    return {
      rollback: rollback.rows[0],
      target: target.rows[0],
      instructions:
        'Su Render seleziona il deploy indicato e usa Rollback/Deploy this commit.'
    };
  }

  return {
    configuredRelease,
    deploymentId,
    current,
    update,
    setMaintenance,
    setBooking,
    assertBookingAllowed,
    registerDeployment,
    deployments,
    markRollback
  };
}
