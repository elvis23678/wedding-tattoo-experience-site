
import crypto from 'node:crypto';
import {
  NOTIFICATION_TYPES,
  renderNotification
} from './notification-templates.js';

function notificationError(message, code = 'NOTIFICATION_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeRecipient(recipient = '') {
  return String(recipient || '').trim();
}

function detectChannel(recipient = '', preferred = 'auto') {
  if (preferred && preferred !== 'auto') return preferred;
  return recipient.includes('@') ? 'email' : 'whatsapp';
}

function normalizePhone(value = '') {
  return String(value || '').replace(/[^\d+]/g, '');
}

function eventKey({
  practiceId = '',
  type,
  recipient = '',
  idempotencyKey = ''
}) {
  if (idempotencyKey) return String(idempotencyKey).slice(0, 240);
  return crypto
    .createHash('sha256')
    .update([practiceId, type, recipient].join('|'))
    .digest('hex');
}

export function createNotificationEngine({
  pool,
  env = process.env,
  logger = console
}) {
  if (!pool?.query || !pool?.connect) {
    throw new Error('Notification Engine: pool PostgreSQL mancante.');
  }

  const config = {
    emailWebhookUrl: String(env.OUTBOUND_EMAIL_WEBHOOK_URL || '').trim(),
    whatsappWebhookUrl: String(env.OUTBOUND_WHATSAPP_WEBHOOK_URL || '').trim(),
    webhookSecret: String(env.OUTBOUND_WEBHOOK_SECRET || '').trim(),
    defaultChannel: String(env.NOTIFICATION_DEFAULT_CHANNEL || 'auto').trim(),
    maxAttempts: Math.max(
      1,
      Math.min(20, Number.parseInt(env.NOTIFICATION_MAX_ATTEMPTS || '5', 10) || 5)
    ),
    retryMinutes: Math.max(
      1,
      Math.min(1440, Number.parseInt(env.NOTIFICATION_RETRY_MINUTES || '15', 10) || 15)
    ),
    batchSize: Math.max(
      1,
      Math.min(500, Number.parseInt(env.NOTIFICATION_BATCH_SIZE || '50', 10) || 50)
    )
  };

  async function signPayload(body) {
    if (!config.webhookSecret) return '';
    return crypto
      .createHmac('sha256', config.webhookSecret)
      .update(body)
      .digest('hex');
  }

  async function sendWebhook(url, payload) {
    const body = JSON.stringify(payload);
    const signature = await signPayload(body);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-WTE-Signature': signature } : {})
      },
      body
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data.error || data.message || `Webhook ${response.status}`
      );
    }
    return data;
  }

  async function deliver(message) {
    const channel = detectChannel(
      message.recipient,
      message.channel || config.defaultChannel
    );

    if (channel === 'email') {
      if (!config.emailWebhookUrl) {
        throw notificationError(
          'Canale e-mail non configurato.',
          'EMAIL_CHANNEL_NOT_CONFIGURED',
          503
        );
      }

      return sendWebhook(config.emailWebhookUrl, {
        channel: 'email',
        to: message.recipient,
        subject: message.subject,
        text: message.body,
        practiceId: message.practice_id,
        messageType: message.message_type,
        metadata: message.metadata || {}
      });
    }

    if (channel === 'whatsapp') {
      if (!config.whatsappWebhookUrl) {
        throw notificationError(
          'Canale WhatsApp non configurato.',
          'WHATSAPP_CHANNEL_NOT_CONFIGURED',
          503
        );
      }

      return sendWebhook(config.whatsappWebhookUrl, {
        channel: 'whatsapp',
        to: normalizePhone(message.recipient),
        text: message.body,
        practiceId: message.practice_id,
        messageType: message.message_type,
        metadata: message.metadata || {}
      });
    }

    throw notificationError(
      `Canale non supportato: ${channel}`,
      'UNSUPPORTED_CHANNEL'
    );
  }

  async function resolvePracticeContact(practiceId) {
    const result = await pool.query(
      'SELECT data FROM wte_practices WHERE id=$1',
      [practiceId]
    );

    if (!result.rowCount) {
      throw notificationError(
        'Pratica non trovata.',
        'PRACTICE_NOT_FOUND',
        404
      );
    }

    const practice = result.rows[0].data || {};
    return {
      practice,
      name: String(practice.name || '').trim(),
      email: String(practice.email || practice.mail || '').trim(),
      phone: String(practice.phone || practice.telefono || '').trim()
    };
  }

  async function queue({
    practiceId = null,
    type,
    recipient = '',
    channel = 'auto',
    subject = '',
    body = '',
    context = {},
    sendAfter = new Date(),
    idempotencyKey = ''
  }) {
    if (!NOTIFICATION_TYPES.includes(type)) {
      throw notificationError(
        `Tipo notifica non valido: ${type}`,
        'INVALID_NOTIFICATION_TYPE'
      );
    }

    let contact = null;
    if (practiceId && !recipient) {
      contact = await resolvePracticeContact(practiceId);
      recipient = contact.email || contact.phone;
      context = {
        customerName: contact.name,
        practiceId,
        ...context
      };
    }

    recipient = normalizeRecipient(recipient);
    if (!recipient) {
      throw notificationError(
        'Destinatario mancante.',
        'RECIPIENT_MISSING'
      );
    }

    const rendered = subject && body
      ? { subject, body }
      : renderNotification(type, context);

    const key = eventKey({
      practiceId,
      type,
      recipient,
      idempotencyKey
    });

    const result = await pool.query(
      `INSERT INTO wte_message_outbox
       (practice_id,message_type,recipient,subject,body,status,send_after,
        metadata,channel,attempts,last_error,provider_message_id,locked_at,
        event_key)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7::jsonb,$8,0,'','',NULL,$9)
       ON CONFLICT (event_key)
       DO UPDATE SET
         recipient=EXCLUDED.recipient,
         subject=EXCLUDED.subject,
         body=EXCLUDED.body,
         send_after=LEAST(wte_message_outbox.send_after,EXCLUDED.send_after),
         metadata=wte_message_outbox.metadata || EXCLUDED.metadata,
         updated_at=NOW()
       RETURNING id,practice_id,message_type,recipient,subject,body,status,
                 send_after,metadata,channel,attempts,created_at`,
      [
        practiceId,
        type,
        recipient,
        rendered.subject,
        rendered.body,
        sendAfter,
        JSON.stringify(context || {}),
        channel,
        key
      ]
    );

    return result.rows[0];
  }

  async function queueForPractice(practiceId, type, {
    context = {},
    channel = 'auto',
    sendAfter = new Date(),
    idempotencyKey = ''
  } = {}) {
    return queue({
      practiceId,
      type,
      channel,
      context,
      sendAfter,
      idempotencyKey
    });
  }

  async function claimBatch(limit = config.batchSize) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || config.batchSize, 500));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id,practice_id,message_type,recipient,subject,body,status,
                send_after,metadata,channel,attempts
         FROM wte_message_outbox
         WHERE status='pending'
           AND send_after<=NOW()
           AND (locked_at IS NULL OR locked_at<NOW()-INTERVAL '15 minutes')
         ORDER BY send_after ASC,id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [safeLimit]
      );

      if (result.rowCount) {
        await client.query(
          `UPDATE wte_message_outbox
           SET locked_at=NOW(),updated_at=NOW()
           WHERE id=ANY($1::bigint[])`,
          [result.rows.map(row => row.id)]
        );
      }

      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function markSent(messageId, provider = {}) {
    const providerMessageId = String(
      provider.id ||
      provider.messageId ||
      provider.reference ||
      ''
    ).slice(0, 240);

    const result = await pool.query(
      `UPDATE wte_message_outbox
       SET status='sent',
           sent_at=NOW(),
           locked_at=NULL,
           attempts=attempts+1,
           last_error='',
           provider_message_id=$2,
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [messageId, providerMessageId]
    );
    return result.rows[0] || null;
  }

  async function markFailed(message, error) {
    const attempts = Number(message.attempts || 0) + 1;
    const terminal = attempts >= config.maxAttempts;
    const retryAt = new Date(
      Date.now() + config.retryMinutes * 60_000
    );

    const result = await pool.query(
      `UPDATE wte_message_outbox
       SET status=$2,
           locked_at=NULL,
           attempts=$3,
           last_error=$4,
           send_after=$5,
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [
        message.id,
        terminal ? 'failed' : 'pending',
        attempts,
        String(error.message || error).slice(0, 4000),
        retryAt
      ]
    );
    return result.rows[0] || null;
  }

  async function dispatch(limit = config.batchSize) {
    const batch = await claimBatch(limit);
    let sent = 0;
    let failed = 0;
    let retrying = 0;
    const details = [];

    for (const message of batch) {
      try {
        const provider = await deliver(message);
        const updated = await markSent(message.id, provider);
        sent++;
        details.push({
          id: message.id,
          result: 'sent',
          providerMessageId: updated?.provider_message_id || ''
        });
      } catch (error) {
        const updated = await markFailed(message, error);
        if (updated?.status === 'failed') {
          failed++;
        } else {
          retrying++;
        }
        details.push({
          id: message.id,
          result: updated?.status || 'failed',
          error: error.message
        });
      }
    }

    return {
      processed: batch.length,
      sent,
      failed,
      retrying,
      details
    };
  }

  async function list({
    status = '',
    practiceId = '',
    limit = 100,
    offset = 0
  } = {}) {
    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`status=$${params.length}`);
    }
    if (practiceId) {
      params.push(practiceId);
      where.push(`practice_id=$${params.length}`);
    }

    params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
    const limitIndex = params.length;
    params.push(Math.max(0, Number(offset) || 0));
    const offsetIndex = params.length;

    const result = await pool.query(
      `SELECT id,event_key,practice_id,message_type,recipient,subject,body,
              status,send_after,sent_at,metadata,channel,attempts,last_error,
              provider_message_id,created_at,updated_at
       FROM wte_message_outbox
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    );

    return result.rows;
  }

  async function retry(messageId) {
    const result = await pool.query(
      `UPDATE wte_message_outbox
       SET status='pending',
           attempts=0,
           last_error='',
           locked_at=NULL,
           send_after=NOW(),
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [messageId]
    );

    if (!result.rowCount) {
      throw notificationError(
        'Messaggio non trovato.',
        'MESSAGE_NOT_FOUND',
        404
      );
    }
    return result.rows[0];
  }

  async function cancel(messageId) {
    const result = await pool.query(
      `UPDATE wte_message_outbox
       SET status='cancelled',
           locked_at=NULL,
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [messageId]
    );

    if (!result.rowCount) {
      throw notificationError(
        'Messaggio non trovato.',
        'MESSAGE_NOT_FOUND',
        404
      );
    }
    return result.rows[0];
  }

  function status() {
    return {
      emailConfigured: Boolean(config.emailWebhookUrl),
      whatsappConfigured: Boolean(config.whatsappWebhookUrl),
      signedWebhooks: Boolean(config.webhookSecret),
      defaultChannel: config.defaultChannel,
      maxAttempts: config.maxAttempts,
      retryMinutes: config.retryMinutes,
      batchSize: config.batchSize,
      notificationTypes: NOTIFICATION_TYPES
    };
  }

  return {
    types: NOTIFICATION_TYPES,
    config,
    status,
    queue,
    queueForPractice,
    dispatch,
    list,
    retry,
    cancel,
    deliver
  };
}
