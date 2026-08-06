
import crypto from 'node:crypto';

function availabilityError(message, code = 'DATE_NOT_AVAILABLE', statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeDate(value = '') {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw availabilityError(
      'Data evento non valida.',
      'INVALID_EVENT_DATE',
      400
    );
  }
  return date;
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

export function createDateAvailabilityEngine({
  pool,
  holdMinutes = 30,
  logger = console
}) {
  if (!pool?.query || !pool?.connect) {
    throw new Error('Date Availability Engine: pool PostgreSQL mancante.');
  }

  const safeHoldMinutes = Math.max(
    5,
    Math.min(180, Number(holdMinutes) || 30)
  );

  async function cleanupExpired(client = pool) {
    const result = await client.query(
      `UPDATE wte_date_reservations
       SET status='expired',updated_at=NOW()
       WHERE status='hold'
         AND expires_at<=NOW()
       RETURNING id,event_date,practice_id`
    );
    return result.rows;
  }

  async function currentReservation(client, eventDate) {
    await cleanupExpired(client);

    const result = await client.query(
      `SELECT id,event_date,status,hold_token,practice_id,contract_token,
              customer_name,customer_email,expires_at,confirmed_at,
              created_at,updated_at
       FROM wte_date_reservations
       WHERE event_date=$1
         AND status IN ('hold','confirmed')
       ORDER BY
         CASE status WHEN 'confirmed' THEN 1 ELSE 2 END,
         created_at ASC
       LIMIT 1`,
      [eventDate]
    );

    return result.rows[0] || null;
  }

  async function check(eventDate, {
    holdToken = '',
    practiceId = ''
  } = {}) {
    const date = normalizeDate(eventDate);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`wte-date:${date}`]
      );

      const reservation = await currentReservation(client, date);
      await client.query('COMMIT');

      if (!reservation) {
        return {
          available: true,
          eventDate: date,
          status: 'free',
          heldByCurrentCustomer: false,
          expiresAt: null
        };
      }

      const owned =
        (holdToken && reservation.hold_token === holdToken) ||
        (practiceId && reservation.practice_id === practiceId);

      return {
        available: Boolean(owned),
        eventDate: date,
        status: reservation.status,
        heldByCurrentCustomer: Boolean(owned),
        expiresAt: owned ? reservation.expires_at : null
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function createHold({
    eventDate,
    customerName = '',
    customerEmail = '',
    contractToken = '',
    existingHoldToken = ''
  }) {
    const date = normalizeDate(eventDate);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`wte-date:${date}`]
      );

      const reservation = await currentReservation(client, date);

      if (reservation) {
        const owned =
          existingHoldToken &&
          reservation.hold_token === existingHoldToken &&
          reservation.status === 'hold';

        if (!owned) {
          throw availabilityError(
            'Questa data è già riservata o confermata.',
            'DATE_NOT_AVAILABLE',
            409
          );
        }

        const renewed = await client.query(
          `UPDATE wte_date_reservations
           SET expires_at=NOW()+($2::text || ' minutes')::interval,
               customer_name=$3,
               customer_email=$4,
               contract_token=COALESCE(NULLIF($5,''),contract_token),
               updated_at=NOW()
           WHERE id=$1
           RETURNING *`,
          [
            reservation.id,
            String(safeHoldMinutes),
            String(customerName || '').slice(0, 180),
            String(customerEmail || '').slice(0, 180),
            String(contractToken || '').slice(0, 180)
          ]
        );

        await client.query('COMMIT');
        return renewed.rows[0];
      }

      const holdToken = token();
      const inserted = await client.query(
        `INSERT INTO wte_date_reservations
         (event_date,status,hold_token,contract_token,customer_name,
          customer_email,expires_at)
         VALUES (
           $1,'hold',$2,NULLIF($3,''),$4,$5,
           NOW()+($6::text || ' minutes')::interval
         )
         RETURNING *`,
        [
          date,
          holdToken,
          String(contractToken || '').slice(0, 180),
          String(customerName || '').slice(0, 180),
          String(customerEmail || '').slice(0, 180),
          String(safeHoldMinutes)
        ]
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

  async function attachToPractice(client, {
    eventDate,
    holdToken,
    practiceId,
    contractToken = ''
  }) {
    const date = normalizeDate(eventDate);

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`wte-date:${date}`]
    );

    await cleanupExpired(client);

    const result = await client.query(
      `UPDATE wte_date_reservations
       SET practice_id=$3,
           contract_token=COALESCE(NULLIF($4,''),contract_token),
           expires_at=NOW()+($5::text || ' minutes')::interval,
           updated_at=NOW()
       WHERE event_date=$1
         AND hold_token=$2
         AND status='hold'
         AND expires_at>NOW()
       RETURNING *`,
      [
        date,
        holdToken,
        practiceId,
        contractToken,
        String(safeHoldMinutes)
      ]
    );

    if (!result.rowCount) {
      throw availabilityError(
        'La riserva temporanea della data è scaduta. Verifica nuovamente la disponibilità.',
        'DATE_HOLD_EXPIRED',
        409
      );
    }

    return result.rows[0];
  }

  async function ensureCheckoutAllowed(practiceId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const practiceResult = await client.query(
        'SELECT data FROM wte_practices WHERE id=$1 FOR UPDATE',
        [practiceId]
      );

      if (!practiceResult.rowCount) {
        throw availabilityError(
          'Pratica non trovata.',
          'PRACTICE_NOT_FOUND',
          404
        );
      }

      const eventDate = normalizeDate(practiceResult.rows[0].data?.date);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`wte-date:${eventDate}`]
      );

      await cleanupExpired(client);
      const reservation = await currentReservation(client, eventDate);

      if (!reservation) {
        throw availabilityError(
          'La data non è più riservata. Torna alla proposta e verifica nuovamente.',
          'DATE_HOLD_MISSING',
          409
        );
      }

      if (reservation.practice_id !== practiceId) {
        throw availabilityError(
          'La data è stata appena riservata da un’altra coppia. Nessun pagamento è stato effettuato.',
          'DATE_NOT_AVAILABLE',
          409
        );
      }

      if (reservation.status === 'hold') {
        await client.query(
          `UPDATE wte_date_reservations
           SET expires_at=NOW()+($2::text || ' minutes')::interval,
               updated_at=NOW()
           WHERE id=$1`,
          [reservation.id, String(safeHoldMinutes)]
        );
      }

      await client.query('COMMIT');

      return {
        allowed: true,
        eventDate,
        reservationStatus: reservation.status
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function confirmForPractice(practiceId, metadata = {}) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const practiceResult = await client.query(
        'SELECT data FROM wte_practices WHERE id=$1 FOR UPDATE',
        [practiceId]
      );

      if (!practiceResult.rowCount) {
        throw availabilityError(
          'Pratica non trovata.',
          'PRACTICE_NOT_FOUND',
          404
        );
      }

      const eventDate = normalizeDate(practiceResult.rows[0].data?.date);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`wte-date:${eventDate}`]
      );

      await cleanupExpired(client);

      const result = await client.query(
        `UPDATE wte_date_reservations
         SET status='confirmed',
             practice_id=$2,
             expires_at=NULL,
             confirmed_at=COALESCE(confirmed_at,NOW()),
             metadata=metadata || $3::jsonb,
             updated_at=NOW()
         WHERE event_date=$1
           AND practice_id=$2
           AND status IN ('hold','confirmed')
         RETURNING *`,
        [eventDate, practiceId, JSON.stringify(metadata || {})]
      );

      if (!result.rowCount) {
        throw availabilityError(
          'Impossibile confermare la data: riserva non trovata.',
          'DATE_CONFIRMATION_FAILED',
          409
        );
      }

      await client.query(
        `UPDATE wte_practices
         SET data=jsonb_set(
           jsonb_set(
             COALESCE(data,'{}'::jsonb),
             '{dateReservationStatus}',
             '"confirmed"'::jsonb,
             TRUE
           ),
           '{dateConfirmedAt}',
           to_jsonb(NOW()::text),
           TRUE
         ),
         updated_at=NOW()
         WHERE id=$1`,
        [practiceId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function release({
    practiceId = '',
    holdToken = '',
    reason = 'released'
  }) {
    if (!practiceId && !holdToken) {
      throw availabilityError(
        'Identificativo riserva mancante.',
        'RESERVATION_IDENTIFIER_MISSING',
        400
      );
    }

    const result = await pool.query(
      `UPDATE wte_date_reservations
       SET status='released',
           release_reason=$3,
           released_at=NOW(),
           updated_at=NOW()
       WHERE status='hold'
         AND (
           ($1<>'' AND practice_id=$1) OR
           ($2<>'' AND hold_token=$2)
         )
       RETURNING *`,
      [practiceId, holdToken, String(reason || '').slice(0, 240)]
    );

    return result.rows[0] || null;
  }

  async function list({
    from = '',
    to = '',
    status = '',
    limit = 200
  } = {}) {
    await cleanupExpired();

    const params = [];
    const conditions = [];

    if (from) {
      params.push(normalizeDate(from));
      conditions.push(`event_date >= $${params.length}`);
    }
    if (to) {
      params.push(normalizeDate(to));
      conditions.push(`event_date <= $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    params.push(Math.max(1, Math.min(Number(limit) || 200, 1000)));

    const result = await pool.query(
      `SELECT id,event_date,status,practice_id,contract_token,
              customer_name,customer_email,expires_at,confirmed_at,
              released_at,release_reason,metadata,created_at,updated_at
       FROM wte_date_reservations
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY event_date ASC,created_at ASC
       LIMIT $${params.length}`,
      params
    );

    return result.rows;
  }

  return {
    holdMinutes: safeHoldMinutes,
    check,
    createHold,
    attachToPractice,
    ensureCheckoutAllowed,
    confirmForPractice,
    release,
    cleanupExpired,
    list
  };
}
