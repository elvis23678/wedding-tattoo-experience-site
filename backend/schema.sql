
CREATE TABLE IF NOT EXISTS wte_practices (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_practices_updated
ON wte_practices(updated_at DESC);

CREATE TABLE IF NOT EXISTS wte_backups (
  id BIGSERIAL PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_backups_created
ON wte_backups(created_at DESC);
