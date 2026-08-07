-- WTE Release 2 - Fase 5
-- Analytics conversioni privacy-friendly.
-- Non memorizza nomi, email, telefoni o indirizzi.

CREATE TABLE IF NOT EXISTS wte_conversion_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_conversion_events_name_time
ON wte_conversion_events(event_name,occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_wte_conversion_events_session
ON wte_conversion_events(session_hash,occurred_at ASC);
