
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

CREATE TABLE IF NOT EXISTS wte_settings (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS wte_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'collaborator',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wte_notifications (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  practice_id TEXT,
  recipient_role TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wte_activity_log (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  practice_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wte_flash_sessions (
  token TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  max_items INTEGER NOT NULL DEFAULT 50,
  selections JSONB NOT NULL DEFAULT '[]'::jsonb,
  customer_name TEXT,
  signature_data TEXT,
  accepted_at TIMESTAMPTZ,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_notifications_created
ON wte_notifications(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wte_activity_created
ON wte_activity_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wte_flash_practice
ON wte_flash_sessions(practice_id);


CREATE TABLE IF NOT EXISTS wte_flash_catalog (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Altro',
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  image_data BYTEA NOT NULL,
  image_mime TEXT NOT NULL,
  image_size INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_flash_catalog_active
ON wte_flash_catalog(active, sort_order, code);

CREATE INDEX IF NOT EXISTS idx_wte_flash_catalog_category
ON wte_flash_catalog(category);


ALTER TABLE wte_users
ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE wte_users
ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT
'{"dashboard":true,"practices":true,"documents":true,"payments":true,"flash":true,"notifications":true,"settings":false,"users":false,"delete_practices":false}'::jsonb;

ALTER TABLE wte_users
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE wte_users
ADD COLUMN IF NOT EXISTS last_login_ip TEXT;

ALTER TABLE wte_users
ADD COLUMN IF NOT EXISTS last_user_agent TEXT;

CREATE TABLE IF NOT EXISTS wte_login_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES wte_users(id) ON DELETE SET NULL,
  email TEXT,
  name TEXT,
  role TEXT,
  ip_address TEXT,
  user_agent TEXT,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_login_log_created
ON wte_login_log(created_at DESC);
