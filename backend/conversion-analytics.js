import crypto from 'node:crypto';

const ALLOWED_EVENTS = new Set([
  'page_view',
  'experience_started',
  'date_available',
  'date_unavailable',
  'proposal_created',
  'contract_opened',
  'contract_signature_started',
  'contract_signed',
  'checkout_started',
  'checkout_redirected',
  'payment_returned',
  'booking_confirmed',
  'couple_area_opened'
]);

function hash(value, secret) {
  return crypto
    .createHash('sha256')
    .update(`${secret}:${String(value || '')}`)
    .digest('hex');
}

function cleanMetadata(value = {}) {
  const out = {};

  for (const [key, item] of Object.entries(value || {})) {
    if (/name|email|phone|address|location/i.test(key)) continue;

    if (typeof item === 'string') {
      out[key] = item.slice(0, 200);
    } else if (
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      out[key] = item;
    }
  }

  return out;
}

export function createConversionAnalytics({
  pool,
  secret = 'wte-analytics',
  logger = console
}) {
  if (!pool?.query) {
    throw new Error('Conversion Analytics: PostgreSQL pool mancante.');
  }

  async function record({
    eventName,
    sessionId,
    visitorId,
    path = '',
    referrerHost = '',
    metadata = {},
    occurredAt = null
  }) {
    if (!ALLOWED_EVENTS.has(eventName)) {
      const error = new Error('Evento analytics non supportato.');
      error.statusCode = 400;
      error.code = 'INVALID_ANALYTICS_EVENT';
      throw error;
    }

    if (!sessionId || !visitorId) {
      const error = new Error('Identificativi analytics mancanti.');
      error.statusCode = 400;
      error.code = 'ANALYTICS_ID_MISSING';
      throw error;
    }

    const occurred = occurredAt
      ? new Date(occurredAt)
      : new Date();

    if (Number.isNaN(occurred.getTime())) {
      const error = new Error('Timestamp analytics non valido.');
      error.statusCode = 400;
      error.code = 'INVALID_ANALYTICS_TIMESTAMP';
      throw error;
    }

    const safeMetadata = cleanMetadata(metadata);

    const eventKey = hash(
      `${eventName}|${sessionId}|${occurred.toISOString()}|${JSON.stringify(safeMetadata)}`,
      secret
    );

    const result = await pool.query(
      `INSERT INTO wte_conversion_events
       (event_key,event_name,session_hash,visitor_hash,path,
        referrer_host,metadata,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [
        eventKey,
        eventName,
        hash(sessionId, secret),
        hash(visitorId, secret),
        String(path || '').slice(0, 300),
        String(referrerHost || '').slice(0, 180),
        JSON.stringify(safeMetadata),
        occurred.toISOString()
      ]
    );

    return { recorded: Boolean(result.rowCount) };
  }

  async function funnel(days = 30) {
    const safeDays = Math.max(
      1,
      Math.min(Number(days) || 30, 365)
    );

    const result = await pool.query(
      `SELECT
         event_name,
         COUNT(*)::int AS events,
         COUNT(DISTINCT session_hash)::int AS sessions
       FROM wte_conversion_events
       WHERE occurred_at >=
         NOW()-($1::text || ' days')::interval
       GROUP BY event_name`,
      [String(safeDays)]
    );

    const byEvent = Object.fromEntries(
      result.rows.map(row => [row.event_name, row])
    );

    const order = [
      'page_view',
      'experience_started',
      'date_available',
      'proposal_created',
      'contract_signed',
      'checkout_redirected',
      'booking_confirmed',
      'couple_area_opened'
    ];

    return order.map((eventName, index) => {
      const sessions =
        Number(byEvent[eventName]?.sessions || 0);

      const previous =
        index === 0
          ? sessions
          : Number(byEvent[order[index - 1]]?.sessions || 0);

      return {
        eventName,
        events:Number(byEvent[eventName]?.events || 0),
        sessions,
        conversionFromPrevious:
          previous > 0
            ? Number(((sessions / previous) * 100).toFixed(1))
            : 0
      };
    });
  }

  async function overview(days = 30) {
    const safeDays = Math.max(
      1,
      Math.min(Number(days) || 30, 365)
    );

    const [steps, packages, daily] = await Promise.all([
      funnel(safeDays),
      pool.query(
        `SELECT
           COALESCE(metadata->>'packageName','Non definito') AS package_name,
           COUNT(*)::int AS proposals,
           ROUND(AVG(
             CASE
               WHEN metadata->>'priceCents' ~ '^[0-9]+$'
               THEN (metadata->>'priceCents')::numeric / 100
               ELSE NULL
             END
           ),2) AS average_price
         FROM wte_conversion_events
         WHERE event_name='proposal_created'
           AND occurred_at >=
             NOW()-($1::text || ' days')::interval
         GROUP BY 1
         ORDER BY proposals DESC`,
        [String(safeDays)]
      ),
      pool.query(
        `SELECT
           DATE(occurred_at) AS day,
           COUNT(*) FILTER (
             WHERE event_name='page_view'
           )::int AS page_views,
           COUNT(DISTINCT session_hash) FILTER (
             WHERE event_name='experience_started'
           )::int AS starts,
           COUNT(DISTINCT session_hash) FILTER (
             WHERE event_name='proposal_created'
           )::int AS proposals,
           COUNT(DISTINCT session_hash) FILTER (
             WHERE event_name='booking_confirmed'
           )::int AS bookings
         FROM wte_conversion_events
         WHERE occurred_at >=
           NOW()-($1::text || ' days')::interval
         GROUP BY DATE(occurred_at)
         ORDER BY day ASC`,
        [String(safeDays)]
      )
    ]);

    return {
      days:safeDays,
      steps,
      packages:packages.rows,
      daily:daily.rows
    };
  }

  return {
    allowedEvents:[...ALLOWED_EVENTS],
    record,
    funnel,
    overview
  };
}
