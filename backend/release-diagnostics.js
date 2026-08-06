
export function createReleaseDiagnostics({
  pool,
  workflow = null,
  scheduler = null,
  notifications = null,
  pdfEngine = null,
  dateAvailability = null,
  stripe = null,
  env = process.env
}) {
  if (!pool?.query) {
    throw new Error('Release Diagnostics: pool PostgreSQL mancante.');
  }

  async function databaseCheck() {
    const started = Date.now();
    const result = await pool.query(
      `SELECT NOW() AS now,
              current_database() AS database,
              version() AS version`
    );

    return {
      ok: true,
      latencyMs: Date.now() - started,
      database: result.rows[0]?.database || '',
      serverTime: result.rows[0]?.now || null
    };
  }

  async function schemaCheck() {
    const requiredTables = [
      'wte_practices',
      'wte_contracts',
      'wte_payment_plans',
      'wte_payment_events',
      'wte_guest_events',
      'wte_guest_votes',
      'wte_message_outbox',
      'wte_workflow_state',
      'wte_scheduler_runs',
      'wte_generated_documents',
      'wte_date_reservations'
    ];

    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema='public'
         AND table_name=ANY($1::text[])`,
      [requiredTables]
    );

    const found = new Set(result.rows.map(row => row.table_name));
    const missing = requiredTables.filter(table => !found.has(table));

    return {
      ok: missing.length === 0,
      required: requiredTables.length,
      found: found.size,
      missing
    };
  }

  async function dataHealth() {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM wte_practices) AS practices,
         (SELECT COUNT(*)::int
          FROM wte_payment_plans
          WHERE deposit_status='paid') AS confirmed_deposits,
         (SELECT COUNT(*)::int
          FROM wte_date_reservations
          WHERE status='confirmed') AS confirmed_dates,
         (SELECT COUNT(*)::int
          FROM wte_date_reservations
          WHERE status='hold' AND expires_at>NOW()) AS active_holds,
         (SELECT COUNT(*)::int
          FROM wte_message_outbox
          WHERE status='failed') AS failed_notifications`
    );

    return {
      ok: true,
      ...result.rows[0]
    };
  }

  function configurationCheck() {
    const checks = {
      databaseUrl: Boolean(env.DATABASE_URL),
      jwtSecret: Boolean(env.JWT_SECRET),
      adminPassword: Boolean(env.ADMIN_PASSWORD),
      publicSiteUrl: Boolean(env.PUBLIC_SITE_URL),
      publicApiUrl: Boolean(env.PUBLIC_API_URL),
      stripeSecretKey: Boolean(env.STRIPE_SECRET_KEY),
      stripeWebhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
      stripeLiveMode:
        String(env.STRIPE_SECRET_KEY || '').startsWith('sk_live_'),
      schedulerEnabled:
        String(env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false'
    };

    const critical = [
      'databaseUrl',
      'jwtSecret',
      'adminPassword',
      'publicSiteUrl',
      'publicApiUrl',
      'stripeSecretKey',
      'stripeWebhookSecret'
    ];

    return {
      ok: critical.every(key => checks[key]),
      checks
    };
  }

  async function run() {
    const startedAt = new Date().toISOString();
    const checks = {};
    let ok = true;

    try {
      checks.database = await databaseCheck();
    } catch (error) {
      checks.database = { ok: false, error: error.message };
      ok = false;
    }

    try {
      checks.schema = await schemaCheck();
      if (!checks.schema.ok) ok = false;
    } catch (error) {
      checks.schema = { ok: false, error: error.message };
      ok = false;
    }

    try {
      checks.data = await dataHealth();
    } catch (error) {
      checks.data = { ok: false, error: error.message };
      ok = false;
    }

    checks.configuration = configurationCheck();
    if (!checks.configuration.ok) ok = false;

    checks.modules = {
      workflow: Boolean(workflow),
      scheduler: Boolean(scheduler),
      notifications: Boolean(notifications),
      pdfEngine: Boolean(pdfEngine),
      dateAvailability: Boolean(dateAvailability),
      stripe: Boolean(stripe)
    };

    if (Object.values(checks.modules).some(value => !value)) {
      ok = false;
    }

    return {
      ok,
      release: env.WTE_RELEASE || '1.0.0',
      environment: env.NODE_ENV || 'development',
      startedAt,
      finishedAt: new Date().toISOString(),
      checks
    };
  }

  return {
    run,
    databaseCheck,
    schemaCheck,
    dataHealth,
    configurationCheck
  };
}
