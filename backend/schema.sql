
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


-- WTE V4 FASE B: area sposi e prenotazione automatica
ALTER TABLE wte_payment_plans
  ADD COLUMN IF NOT EXISTS couple_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS booking_status TEXT NOT NULL DEFAULT 'contract_accepted'
    CHECK (booking_status IN (
      'contract_accepted',
      'deposit_pending',
      'confirmed',
      'balance_pending',
      'ready'
    ));

UPDATE wte_payment_plans
SET couple_token=token
WHERE couple_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wte_payment_plans_couple_token
ON wte_payment_plans(couple_token);


-- WTE V4 PUNTO 1: Workflow Engine
CREATE TABLE IF NOT EXISTS wte_workflow_state (
  practice_id TEXT PRIMARY KEY
    REFERENCES wte_practices(id) ON DELETE CASCADE,
  current_state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (current_state IN (
    'new_request',
    'advisor_completed',
    'contract_ready',
    'contract_accepted',
    'deposit_pending',
    'deposit_paid',
    'guest_selection',
    'guest_selection_closed',
    'flash_pdf_ready',
    'balance_pending',
    'balance_paid',
    'event_ready',
    'event_completed',
    'archived',
    'cancelled'
  ))
);

CREATE INDEX IF NOT EXISTS idx_wte_workflow_state_current
ON wte_workflow_state(current_state,updated_at DESC);

CREATE TABLE IF NOT EXISTS wte_workflow_history (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT UNIQUE NOT NULL,
  practice_id TEXT NOT NULL
    REFERENCES wte_practices(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  actor_name TEXT NOT NULL DEFAULT 'Sistema',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_workflow_history_practice
ON wte_workflow_history(practice_id,id DESC);

CREATE TABLE IF NOT EXISTS wte_workflow_action_queue (
  id BIGSERIAL PRIMARY KEY,
  action_key TEXT UNIQUE NOT NULL,
  practice_id TEXT NOT NULL
    REFERENCES wte_practices(id) ON DELETE CASCADE,
  transition_id BIGINT
    REFERENCES wte_workflow_history(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'processing',
      'completed',
      'failed',
      'cancelled'
    )),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_workflow_action_pending
ON wte_workflow_action_queue(status,available_at,created_at);

CREATE INDEX IF NOT EXISTS idx_wte_workflow_action_practice
ON wte_workflow_action_queue(practice_id,created_at DESC);


-- WTE V4 PUNTO 2: Scheduler Engine
CREATE TABLE IF NOT EXISTS wte_scheduler_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (trigger IN ('startup','scheduled','manual','api')),
  status TEXT NOT NULL
    CHECK (status IN ('running','success','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_wte_scheduler_runs_recent
ON wte_scheduler_runs(job_name,started_at DESC);

CREATE TABLE IF NOT EXISTS wte_scheduler_run_items (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL
    REFERENCES wte_scheduler_runs(id) ON DELETE CASCADE,
  job_name TEXT NOT NULL,
  practice_id TEXT
    REFERENCES wte_practices(id) ON DELETE SET NULL,
  result TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_scheduler_run_items_run
ON wte_scheduler_run_items(run_id,id);

CREATE INDEX IF NOT EXISTS idx_wte_scheduler_run_items_practice
ON wte_scheduler_run_items(practice_id,created_at DESC);


-- WTE V4 PUNTO 3: Notification Engine
ALTER TABLE wte_message_outbox
  ADD COLUMN IF NOT EXISTS event_key TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_wte_message_outbox_event_key
ON wte_message_outbox(event_key)
WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wte_message_outbox_dispatch_v4
ON wte_message_outbox(status,send_after,locked_at);

CREATE TABLE IF NOT EXISTS wte_notification_audit (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT
    REFERENCES wte_message_outbox(id) ON DELETE SET NULL,
  practice_id TEXT
    REFERENCES wte_practices(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  result TEXT NOT NULL,
  provider_message_id TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wte_notification_audit_practice
ON wte_notification_audit(practice_id,created_at DESC);


-- WTE V4 PUNTO 4: PDF Engine
CREATE TABLE IF NOT EXISTS wte_generated_documents (
  id BIGSERIAL PRIMARY KEY,
  practice_id TEXT NOT NULL
    REFERENCES wte_practices(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL
    CHECK (document_type IN (
      'contract',
      'deposit_receipt',
      'balance_receipt',
      'flash_selection',
      'event_bundle'
    )),
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('pending','ready','failed','archived')),
  storage_url TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(practice_id,document_type)
);

CREATE INDEX IF NOT EXISTS idx_wte_generated_documents_practice
ON wte_generated_documents(practice_id,document_type);
