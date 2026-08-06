
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


-- WTE V3 FASE 1: QR invitati e votazione catalogo
CREATE TABLE IF NOT EXISTS wte_guest_events (
  token TEXT PRIMARY KEY,
  practice_id TEXT UNIQUE NOT NULL,
  event_date DATE NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  max_flash INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','finalized')),
  final_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_guest_events_due
ON wte_guest_events(status, closes_at);

CREATE TABLE IF NOT EXISTS wte_guest_votes (
  id BIGSERIAL PRIMARY KEY,
  event_token TEXT NOT NULL
    REFERENCES wte_guest_events(token) ON DELETE CASCADE,
  voter_key TEXT NOT NULL,
  flash_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_token, voter_key)
);

CREATE INDEX IF NOT EXISTS idx_wte_guest_votes_event
ON wte_guest_votes(event_token, flash_code);


-- WTE V3 FASE 2: scadenze, pagamenti, ricevute e promemoria
CREATE TABLE IF NOT EXISTS wte_payment_plans (
  practice_id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  total_cents INTEGER NOT NULL DEFAULT 0,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  deposit_due_at TIMESTAMPTZ,
  balance_due_at TIMESTAMPTZ,
  deposit_payment_url TEXT NOT NULL DEFAULT '',
  balance_payment_url TEXT NOT NULL DEFAULT '',
  deposit_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (deposit_status IN ('pending','paid','cancelled')),
  balance_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (balance_status IN ('pending','paid','cancelled')),
  deposit_paid_at TIMESTAMPTZ,
  balance_paid_at TIMESTAMPTZ,
  deposit_provider TEXT NOT NULL DEFAULT '',
  balance_provider TEXT NOT NULL DEFAULT '',
  deposit_reference TEXT NOT NULL DEFAULT '',
  balance_reference TEXT NOT NULL DEFAULT '',
  deposit_receipt_url TEXT NOT NULL DEFAULT '',
  balance_receipt_url TEXT NOT NULL DEFAULT '',
  reminder_30_sent_at TIMESTAMPTZ,
  reminder_7_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_payment_plans_reminders
ON wte_payment_plans(balance_status,balance_due_at,reminder_30_sent_at,reminder_7_sent_at);

CREATE TABLE IF NOT EXISTS wte_payment_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT UNIQUE NOT NULL,
  practice_id TEXT NOT NULL,
  payment_type TEXT NOT NULL
    CHECK (payment_type IN ('deposit','balance')),
  status TEXT NOT NULL
    CHECK (status IN ('pending','paid','failed','refunded','cancelled')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  provider TEXT NOT NULL DEFAULT '',
  provider_reference TEXT NOT NULL DEFAULT '',
  receipt_url TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_payment_events_practice
ON wte_payment_events(practice_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS wte_message_outbox (
  id BIGSERIAL PRIMARY KEY,
  practice_id TEXT,
  message_type TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','cancelled','failed')),
  send_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_message_outbox_pending
ON wte_message_outbox(status,send_after);


-- WTE V3 FASE 3: assistente pacchetto, sessioni commerciali e contratti
CREATE TABLE IF NOT EXISTS wte_service_packages (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  deposit_percent INTEGER NOT NULL DEFAULT 30
    CHECK (deposit_percent BETWEEN 0 AND 100),
  included_hours NUMERIC(5,2) NOT NULL DEFAULT 0,
  min_guests INTEGER NOT NULL DEFAULT 0,
  max_guests INTEGER NOT NULL DEFAULT 5000,
  max_distance_km INTEGER NOT NULL DEFAULT 5000,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO wte_service_packages
(code,name,description,reason,price_cents,deposit_percent,included_hours,min_guests,max_guests,max_distance_km,sort_order,features)
VALUES
(
 'BRONZE','Bronze',
 'Formula essenziale per matrimoni intimi.',
 'Adatta a eventi raccolti, durata contenuta e numero ridotto di invitati.',
 79000,30,3,0,65,100,10,
 '["Servizio Wedding Tattoo Experience","Catalogo flash","Gestione pratica digitale"]'::jsonb
),
(
 'SILVER','Silver',
 'Formula equilibrata per la maggior parte dei matrimoni.',
 'Offre un buon equilibrio tra durata, invitati e possibilità di coinvolgimento.',
 109000,30,5,40,110,160,20,
 '["Servizio Wedding Tattoo Experience","Catalogo flash","Gestione pratica digitale","QR invitati"]'::jsonb
),
(
 'GOLD','Gold',
 'Formula estesa per eventi più grandi.',
 'Pensata per maggiore affluenza, durata più lunga e organizzazione completa.',
 169000,30,7,80,150,220,30,
 '["Servizio Wedding Tattoo Experience","Catalogo flash","Gestione pratica digitale","QR invitati","Presenza estesa"]'::jsonb
),
(
 'LUXURY','Luxury',
 'Proposta personalizzata per esigenze fuori standard.',
 'Indicata per grandi eventi, trasferte estese o richieste organizzative speciali.',
 0,30,9,120,5000,5000,40,
 '["Progetto personalizzato","Catalogo flash","Gestione pratica digitale","QR invitati","Assistenza dedicata"]'::jsonb
)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS wte_sales_sessions (
  token TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'recommended'
    CHECK (status IN ('recommended','contract_ready','accepted','expired')),
  customer_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
  package_code TEXT REFERENCES wte_service_packages(code),
  ai_used BOOLEAN NOT NULL DEFAULT FALSE,
  ai_summary TEXT NOT NULL DEFAULT '',
  contract_token TEXT,
  practice_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_sales_sessions_status
ON wte_sales_sessions(status,created_at DESC);

CREATE TABLE IF NOT EXISTS wte_contracts (
  token TEXT PRIMARY KEY,
  sales_token TEXT UNIQUE NOT NULL
    REFERENCES wte_sales_sessions(token) ON DELETE CASCADE,
  practice_id TEXT,
  package_code TEXT NOT NULL REFERENCES wte_service_packages(code),
  contract_number TEXT UNIQUE NOT NULL,
  customer_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  package_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  clauses JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','accepted','cancelled')),
  signer_name TEXT NOT NULL DEFAULT '',
  signature_data TEXT,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_contracts_practice
ON wte_contracts(practice_id,status);


-- WTE V3 FASE 4: invii automatici, workflow ed eccezioni
ALTER TABLE wte_message_outbox
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'auto'
    CHECK (channel IN ('auto','email','whatsapp')),
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_wte_message_outbox_dispatch
ON wte_message_outbox(status,send_after,locked_at);

CREATE TABLE IF NOT EXISTS wte_workflow_exceptions (
  id BIGSERIAL PRIMARY KEY,
  practice_id TEXT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info','warning','critical')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(practice_id,code,status)
);

CREATE INDEX IF NOT EXISTS idx_wte_workflow_exceptions_open
ON wte_workflow_exceptions(status,severity,detected_at DESC);

CREATE TABLE IF NOT EXISTS wte_workflow_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
