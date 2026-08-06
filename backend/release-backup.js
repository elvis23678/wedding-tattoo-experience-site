
import crypto from 'node:crypto';

const TABLES = Object.freeze([
  'wte_practices',
  'wte_contracts',
  'wte_payment_plans',
  'wte_payment_events',
  'wte_guest_events',
  'wte_guest_votes',
  'wte_workflow_state',
  'wte_workflow_history',
  'wte_generated_documents',
  'wte_date_reservations'
]);

function redactRows(table, rows) {
  if (table === 'wte_contracts') {
    return rows.map(row => ({
      ...row,
      signature_data: row.signature_data ? '[REDACTED]' : ''
    }));
  }

  return rows;
}

export function createReleaseBackup({
  pool,
  releaseManager
}) {
  if (!pool?.query) {
    throw new Error('Release Backup: pool PostgreSQL mancante.');
  }

  async function exportJson({
    includeSensitive = false
  } = {}) {
    const release = await releaseManager.current();
    const data = {};

    for (const table of TABLES) {
      const result = await pool.query(
        `SELECT * FROM ${table} ORDER BY 1 ASC`
      );

      data[table] = includeSensitive
        ? result.rows
        : redactRows(table, result.rows);
    }

    const payload = {
      format: 'wte-release-backup-v1',
      release: release.release_name,
      generatedAt: new Date().toISOString(),
      includeSensitive: Boolean(includeSensitive),
      tables: data
    };

    const json = JSON.stringify(payload, null, 2);
    const checksum = crypto
      .createHash('sha256')
      .update(json)
      .digest('hex');

    return {
      payload,
      json,
      checksum,
      filename:
        `WTE_backup_${release.release_name}_${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')}.json`
    };
  }

  async function counts() {
    const output = {};

    for (const table of TABLES) {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${table}`
      );
      output[table] = result.rows[0]?.count || 0;
    }

    return output;
  }

  return {
    tables: TABLES,
    exportJson,
    counts
  };
}
