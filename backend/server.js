
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import pg from 'pg';
import { z } from 'zod';
import { createWorkflowEngine, WORKFLOW_STATES, WORKFLOW_TRANSITIONS } from './workflow-engine.js';
import { createSchedulerEngine } from './scheduler-engine.js';
import { createNotificationEngine } from './notification-engine.js';
import { createPdfEngine } from './pdf-engine.js';
import { createDateAvailabilityEngine } from './date-availability-engine.js';
import { createReleaseDiagnostics } from './release-diagnostics.js';
import { createReleaseManager } from './release-manager.js';
import { createReleaseBackup } from './release-backup.js';
import { createConversionAnalytics } from './conversion-analytics.js';
import Stripe from 'stripe';

const { Pool } = pg;

const app = express();
app.set('trust proxy',1);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.weddingtattooexperience.it';
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6';
const OUTBOUND_EMAIL_WEBHOOK_URL = process.env.OUTBOUND_EMAIL_WEBHOOK_URL || '';
const OUTBOUND_WHATSAPP_WEBHOOK_URL = process.env.OUTBOUND_WHATSAPP_WEBHOOK_URL || '';
const OUTBOUND_WEBHOOK_SECRET = process.env.OUTBOUND_WEBHOOK_SECRET || '';
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://www.weddingtattooexperience.it';
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || 'https://wte-cloud-api.onrender.com').replace(/\/$/,'');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_CURRENCY = String(process.env.STRIPE_CURRENCY || 'eur').toLowerCase();
// TEST TEMPORANEO: forza SOLO l'acconto Stripe a 1,00 €. Da rimuovere dopo il collaudo.
const STRIPE_ONE_EURO_TEST = true;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

if (!JWT_SECRET || !ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('Mancano JWT_SECRET, ADMIN_PASSWORD o DATABASE_URL.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized:false }
    : false
});

const workflow = createWorkflowEngine({
  pool,
  logger: console,
  onTransition({state,transition,actions}) {
    console.log(
      `[WORKFLOW] ${transition.practice_id}: ` +
      `${transition.from_state || '∅'} -> ${state.current_state}` +
      (actions.length ? ` | azioni: ${actions.join(', ')}` : '')
    );
  }
});

const notifications = createNotificationEngine({
  pool,
  env:process.env,
  logger:console
});

const pdfEngine = createPdfEngine({
  pool,
  logger:console
});

const dateAvailability = createDateAvailabilityEngine({
  pool,
  holdMinutes:Number(process.env.DATE_HOLD_MINUTES||30),
  logger:console
});


const releaseManager = createReleaseManager({
  pool,
  env:process.env,
  logger:console
});

const releaseBackup = createReleaseBackup({
  pool,
  releaseManager
});

const conversionAnalytics = createConversionAnalytics({
  pool,
  secret:process.env.ANALYTICS_HASH_SECRET||JWT_SECRET,
  logger:console
});

const scheduler = createSchedulerEngine({
  pool,
  workflow,
  env:process.env,
  logger:console,
  onGuestFinalized({practiceId,finalCodes,pdfUrl}) {
    return notifications.queueForPractice(
      practiceId,
      'flash_pdf_ready',
      {
        context:{
          practiceId,
          pdfUrl,
          finalCount:finalCodes.length
        },
        idempotencyKey:`flash_pdf_ready:${practiceId}`
      }
    ).catch(error=>console.error('Scheduler notification error',error));
  },
  onCycleCompleted(){
    return notifications.dispatch();
  },
  onDocumentReady({practiceId,type,url,metadata}){
    return pdfEngine.registerDocument({
      practiceId,
      type,
      storageUrl:url,
      metadata
    });
  }
});

const releaseDiagnostics = createReleaseDiagnostics({
  pool,
  workflow,
  scheduler,
  notifications,
  pdfEngine,
  dateAvailability,
  stripe,
  env:process.env
});

app.use(helmet());
const allowedOrigins = new Set([
  ...ALLOWED_ORIGIN.split(',').map(v => v.trim()).filter(Boolean),
  'https://www.weddingtattooexperience.it',
  'https://weddingtattooexperience.it',
  'https://admin.weddingtattooexperience.it',
  'https://wte-admin.onrender.com'
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`Origin non autorizzata: ${origin}`));
  },
  methods:['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization','X-WTE-Device','X-WTE-Request-Id']
}));

// Stripe richiede il body RAW per verificare la firma del webhook.
app.post(
  ['/api/stripe/webhook','/api/payments/webhook'],
  express.raw({type:'application/json'}),
  async (req,res) => {
    if(!stripe || !STRIPE_WEBHOOK_SECRET){
      return res.status(503).send('Stripe non configurato.');
    }

    const signature=String(req.headers['stripe-signature']||'');
    let event;

    try{
      event=stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    }catch(error){
      console.error('Stripe webhook signature error',error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try{
      const supported=[
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
        'checkout.session.expired'
      ];

      if(!supported.includes(event.type)){
        return res.json({received:true,ignored:true});
      }

      const session=event.data.object;
      const practiceId=String(session.metadata?.practiceId||'');
      const paymentType=
        session.metadata?.paymentType==='balance'?'balance':'deposit';

      if(!practiceId){
        return res.status(400).json({
          error:'Metadata practiceId mancante.'
        });
      }

      if(
        event.type==='checkout.session.completed' ||
        event.type==='checkout.session.async_payment_succeeded'
      ){
        if(session.payment_status!=='paid'){
          return res.json({received:true,processed:false});
        }

        let receiptUrl='';
        let providerReference=String(session.payment_intent||session.id);

        if(session.payment_intent){
          try{
            const paymentIntent=await stripe.paymentIntents.retrieve(
              String(session.payment_intent),
              {expand:['latest_charge']}
            );
            const charge=paymentIntent.latest_charge;
            if(charge && typeof charge!=='string'){
              receiptUrl=String(charge.receipt_url||'');
              providerReference=String(charge.id||paymentIntent.id);
            }
          }catch(error){
            console.error('Stripe receipt retrieve error',error.message);
          }
        }

        await applyPaidPayment({
          practiceId,
          paymentType,
          amountCents:Number(session.amount_total||0),
          provider:'stripe',
          reference:providerReference,
          receiptUrl,
          eventKey:event.id,
          occurredAt:new Date(event.created*1000),
          payload:{
            stripeEventId:event.id,
            checkoutSessionId:session.id,
            paymentIntentId:String(session.payment_intent||'')
          }
        });

        if(paymentType==='deposit'){
          await dateAvailability.confirmForPractice(practiceId,{
            provider:'stripe',
            stripeEventId:event.id,
            checkoutSessionId:session.id
          });
        }

        await pool.query(
          `UPDATE wte_payment_plans
           SET stripe_customer_id=COALESCE($2,stripe_customer_id),
               updated_at=NOW()
           WHERE practice_id=$1`,
          [practiceId,String(session.customer||'')||null]
        );
      }else{
        await pool.query(
          `INSERT INTO wte_payment_events
           (event_key,practice_id,payment_type,status,amount_cents,currency,
            provider,provider_reference,receipt_url,payload,occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,'stripe',$7,'',$8::jsonb,NOW())
           ON CONFLICT (event_key) DO NOTHING`,
          [
            event.id,
            practiceId,
            paymentType,
            event.type==='checkout.session.expired'?'cancelled':'failed',
            Number(session.amount_total||0),
            String(session.currency||STRIPE_CURRENCY).toUpperCase(),
            String(session.id||''),
            JSON.stringify({stripeEventId:event.id,type:event.type})
          ]
        );
      }

      return res.json({received:true});
    }catch(error){
      console.error('Stripe webhook processing error',error);
      return res.status(500).json({error:'Elaborazione webhook fallita.'});
    }
  }
);

app.use(express.json({limit:'5mb'}));

const PracticeSchema = z.object({
  id:z.string().min(1).max(160),
  createdAt:z.string().optional(),
  updatedAt:z.string().optional()
}).passthrough();

function auth(req,res,next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({error:'Autenticazione richiesta.'});

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({error:'Sessione non valida o scaduta.'});
  }
}

function adminOnly(req,res,next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({error:'Operazione riservata all’amministratore.'});
  }
  next();
}

async function logActivity(req, action, practiceId = null, details = {}) {
  try {
    await pool.query(
      `INSERT INTO wte_activity_log (actor, actor_role, action, practice_id, details)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [req.user?.name || req.user?.email || 'Sistema', req.user?.role || 'system',
       action, practiceId, JSON.stringify(details)]
    );
  } catch (error) {
    console.error('Activity log error', error);
  }
}

async function createNotification(type,title,body,practiceId=null,recipientRole=null) {
  await pool.query(
    `INSERT INTO wte_notifications (type,title,body,practice_id,recipient_role)
     VALUES ($1,$2,$3,$4,$5)`,
    [type,title,body,practiceId,recipientRole]
  );
}


let offersSchemaReady=false;
async function ensureOffersSchema(){
  if(offersSchemaReady)return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wte_offers (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('percent','fixed','gift')),
      value NUMERIC(12,2) NOT NULL DEFAULT 0,
      gift TEXT NOT NULL DEFAULT '',
      start_date DATE,
      end_date DATE,
      scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','personal')),
      client_id TEXT,
      client_name TEXT,
      message TEXT NOT NULL DEFAULT '',
      show_popup BOOLEAN NOT NULL DEFAULT TRUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wte_offers_active_dates
    ON wte_offers(active,start_date,end_date);
  `);
  offersSchemaReady=true;
}

function offerRow(row){
  return {
    id:row.id,
    title:row.title,
    type:row.type,
    value:Number(row.value||0),
    gift:row.gift||'',
    startDate:row.start_date
      ?new Date(row.start_date).toISOString().slice(0,10)
      :null,
    endDate:row.end_date
      ?new Date(row.end_date).toISOString().slice(0,10)
      :null,
    scope:row.scope,
    clientId:row.client_id||null,
    clientName:row.client_name||null,
    message:row.message||'',
    showPopup:Boolean(row.show_popup),
    active:Boolean(row.active),
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
}

app.get('/api/health', async (_req,res) => {
  const result = await pool.query('SELECT NOW() AS now');
  res.json({ok:true, version:'5.0.0-conversion-analytics', dbTime:result.rows[0].now});
});

app.post('/api/auth/login', async (req,res) => {
  const parsed = z.object({
    email:z.string().email().optional().or(z.literal('')),
    password:z.string().min(1)
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({error:'Inserisci credenziali valide.'});
  }

  const ipAddress = String(
    req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
  ).split(',')[0].trim();
  const userAgent = String(req.headers['user-agent'] || '').slice(0,500);

  // Accesso proprietario compatibile con la password Admin Cloud.
  if (!parsed.data.email && parsed.data.password === ADMIN_PASSWORD) {
    const owner = {
      id:null,
      email:'admin@wte.local',
      name:'Amministratore',
      role:'admin',
      mustChangePassword:false,
      permissions:{
        dashboard:true,practices:true,documents:true,payments:true,flash:true,
        notifications:true,settings:true,users:true,delete_practices:true
      }
    };

    const token = jwt.sign(
      {
        role:owner.role,
        name:owner.name,
        email:owner.email,
        permissions:owner.permissions,
        legacyOwner:true
      },
      JWT_SECRET,
      {expiresIn:'30d'}
    );

    await pool.query(
      `INSERT INTO wte_login_log
       (email,name,role,ip_address,user_agent,success)
       VALUES ($1,$2,$3,$4,$5,TRUE)`,
      [owner.email,owner.name,owner.role,ipAddress,userAgent]
    );

    return res.json({token,user:owner});
  }

  const result = await pool.query(
    `SELECT id,email,name,password_hash,role,enabled,must_change_password,
            permissions,last_login_at
     FROM wte_users
     WHERE LOWER(email)=LOWER($1)`,
    [parsed.data.email]
  );

  const user = result.rows[0];
  const valid = Boolean(
    user && user.enabled &&
    await bcrypt.compare(parsed.data.password,user.password_hash)
  );

  if (!valid) {
    await pool.query(
      `INSERT INTO wte_login_log
       (user_id,email,name,role,ip_address,user_agent,success)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE)`,
      [user?.id || null,parsed.data.email,user?.name || '',user?.role || '',
       ipAddress,userAgent]
    );
    return res.status(401).json({error:'Email o password non corretti.'});
  }

  await pool.query(
    `UPDATE wte_users
     SET last_login_at=NOW(),last_login_ip=$2,last_user_agent=$3,updated_at=NOW()
     WHERE id=$1`,
    [user.id,ipAddress,userAgent]
  );

  await pool.query(
    `INSERT INTO wte_login_log
     (user_id,email,name,role,ip_address,user_agent,success)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
    [user.id,user.email,user.name,user.role,ipAddress,userAgent]
  );

  const token = jwt.sign(
    {
      sub:user.id,
      role:user.role,
      name:user.name,
      email:user.email,
      permissions:user.permissions || {}
    },
    JWT_SECRET,
    {expiresIn:'30d'}
  );

  res.json({
    token,
    user:{
      id:user.id,
      email:user.email,
      name:user.name,
      role:user.role,
      mustChangePassword:user.must_change_password,
      permissions:user.permissions || {},
      lastLoginAt:user.last_login_at
    }
  });
});


const PublicPracticeSchema = PracticeSchema.extend({
  name:z.string().max(180).optional().default(''),
  date:z.string().max(40).optional().default(''),
  location:z.string().max(240).optional().default(''),
  guests:z.number().int().min(0).max(5000).optional().default(0),
  hours:z.number().min(0).max(72).optional().default(0),
  distance:z.number().min(0).max(5000).optional().default(0),
  status:z.string().max(80).optional().default('Nuova'),
  type:z.string().max(120).optional().default('Richiesta sito')
}).passthrough();

const intakeHits = new Map();

function publicRateLimit(req,res,next) {
  const now = Date.now();
  const key = String(req.ip || req.headers['x-forwarded-for'] || 'unknown');
  const previous = (intakeHits.get(key) || []).filter(ts => now - ts < 60_000);

  if (previous.length >= 20) {
    return res.status(429).json({error:'Troppe richieste. Riprova tra un minuto.'});
  }

  previous.push(now);
  intakeHits.set(key, previous);
  next();
}


app.get('/api/availability', async (_req,res) => {
  const result = await pool.query(
    `SELECT data->>'date' AS date, COUNT(*)::int AS count
     FROM wte_practices
     WHERE COALESCE(data->>'status','') NOT IN ('Annullato','Annullata','Archiviato','Archiviata')
       AND COALESCE(data->>'date','') <> ''
     GROUP BY data->>'date'
     ORDER BY data->>'date'`
  );

  res.json({dates:result.rows});
});

app.get('/api/availability/:date', async (req,res) => {
  const result = await pool.query(
    `SELECT data
     FROM wte_practices
     WHERE data->>'date' = $1
       AND COALESCE(data->>'status','') NOT IN ('Annullato','Annullata','Archiviato','Archiviata')
     ORDER BY updated_at DESC`,
    [req.params.date]
  );

  res.json({
    date:req.params.date,
    available:result.rowCount===0,
    practices:result.rows.map(row=>row.data)
  });
});

app.post('/api/public/practices', publicRateLimit, async (req,res) => {
  const parsed = PublicPracticeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({error:'Dati della richiesta non validi.'});
  }

  const practice = {
    ...parsed.data,
    status: parsed.data.status || 'Nuova',
    source: 'sito-clienti',
    updatedAt: new Date().toISOString()
  };

  const saved = await pool.query(
    `INSERT INTO wte_practices (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [practice.id, JSON.stringify(practice)]
  );

  const inserted = Boolean(saved.rows[0]?.inserted);

  if (inserted) {
    await createNotification(
      'new_practice',
      'Nuova richiesta Wedding',
      `${practice.name || 'Un cliente'} ha inviato una richiesta per il ${practice.date || 'data da definire'}.`,
      practice.id,
      null
    );
  }

  res.status(inserted ? 201 : 200).json({
    ok:true,
    id:practice.id,
    duplicate:!inserted
  });
});


app.get('/api/settings', auth, async (_req,res) => {
  const result = await pool.query(`SELECT data FROM wte_settings WHERE id = 'global'`);
  res.json({settings:result.rows[0]?.data || {}});
});

app.post('/api/settings', auth, async (req,res) => {
  const parsed = z.record(z.any()).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:'Impostazioni non valide.'});
  await pool.query(
    `INSERT INTO wte_settings (id, data, updated_at)
     VALUES ('global', $1::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [JSON.stringify(parsed.data)]
  );
  res.json({ok:true});
});

app.get('/api/practices', auth, async (_req,res) => {
  const result = await pool.query(
    'SELECT data FROM wte_practices ORDER BY updated_at DESC'
  );

  res.json({practices:result.rows.map(row => row.data)});
});

app.post('/api/practices/sync', auth, async (req,res) => {
  const parsed = z.object({
    practices:z.array(PracticeSchema).max(5000)
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({error:'Archivio non valido.'});
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const practice of parsed.data.practices) {
      await client.query(
        `INSERT INTO wte_practices (id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [practice.id, JSON.stringify(practice)]
      );
    }

    await client.query(
      `INSERT INTO wte_backups (data, created_at)
       VALUES ($1::jsonb, NOW())`,
      [JSON.stringify(parsed.data.practices)]
    );

    await client.query(
      `DELETE FROM wte_backups
       WHERE id NOT IN (
         SELECT id FROM wte_backups ORDER BY created_at DESC LIMIT 30
       )`
    );

    await client.query('COMMIT');
    res.json({ok:true, count:parsed.data.practices.length});
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({error:'Errore durante la sincronizzazione.'});
  } finally {
    client.release();
  }
});


app.post('/api/practices/:id/documents', auth, async (req,res) => {
  const parsed = z.object({
    documentType:z.enum(['quote','contract']),
    data:z.record(z.any())
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({error:'Documento non valido.'});
  }

  const result = await pool.query(
    'SELECT data FROM wte_practices WHERE id = $1',
    [req.params.id]
  );

  if (!result.rowCount) {
    return res.status(404).json({error:'Pratica non trovata.'});
  }

  const practice = result.rows[0].data;
  practice.documents = practice.documents || {};
  practice.documents[parsed.data.documentType] = {
    ...parsed.data.data,
    savedAt:new Date().toISOString()
  };
  practice.updatedAt = new Date().toISOString();

  await pool.query(
    `UPDATE wte_practices
     SET data = $2::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [req.params.id, JSON.stringify(practice)]
  );

  res.json({ok:true});
});



function flashCodeNumber(code) {
  const match = String(code || '').match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function nextFlashCode(prefix = 'WTE') {
  const result = await pool.query(
    `SELECT code FROM wte_flash_catalog
     WHERE code LIKE $1
     ORDER BY id DESC LIMIT 500`,
    [`${prefix}-%`]
  );
  const max = result.rows.reduce((value,row) => Math.max(value,flashCodeNumber(row.code)),0);
  return `${prefix}-${String(max + 1).padStart(4,'0')}`;
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Immagine non valida.');
  return {mime:match[1], buffer:Buffer.from(match[2],'base64')};
}

app.get('/api/public/flash-catalog', async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  const category = String(req.query.category || '').trim();
  const search = String(req.query.search || '').trim();

  const values = [];
  const where = ['active=TRUE'];

  if (category) {
    values.push(category);
    where.push(`category=$${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    where.push(`(
      code ILIKE $${values.length}
      OR title ILIKE $${values.length}
      OR category ILIKE $${values.length}
      OR array_to_string(tags,' ') ILIKE $${values.length}
    )`);
  }

  const result = await pool.query(
    `SELECT id,code,title,category,tags,image_mime,image_size,sort_order,updated_at
     FROM wte_flash_catalog
     WHERE ${where.join(' AND ')}
     ORDER BY sort_order ASC, code ASC`,
    values
  );

  res.json({
    items:result.rows.map(item => ({
      ...item,
      image:`https://${req.get('host')}/api/public/flash-catalog/${item.id}/image`
    }))
  });
});

app.get('/api/public/flash-catalog/:id/image', async (req,res) => {
  const result = await pool.query(
    `SELECT image_data,image_mime FROM wte_flash_catalog
     WHERE id=$1 AND active=TRUE`,
    [req.params.id]
  );

  if (!result.rowCount) return res.status(404).end();

  // Consente al dominio pubblico di mostrare le immagini servite dall'API Render.
  res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type',result.rows[0].image_mime);
  res.setHeader('Cache-Control','public,max-age=86400');
  res.send(result.rows[0].image_data);
});

app.get('/api/flash-catalog', auth, async (req,res) => {
  const result = await pool.query(
    `SELECT id,code,title,category,tags,image_mime,image_size,active,
            sort_order,created_by,created_at,updated_at
     FROM wte_flash_catalog
     ORDER BY active DESC,sort_order ASC,code ASC`
  );

  res.json({
    items:result.rows.map(item => ({
      ...item,
      image:`${req.protocol}://${req.get('host')}/api/flash-catalog/${item.id}/image`
    }))
  });
});

app.get('/api/flash-catalog/:id/image', auth, async (req,res) => {
  const result = await pool.query(
    'SELECT image_data,image_mime FROM wte_flash_catalog WHERE id=$1',
    [req.params.id]
  );

  if (!result.rowCount) return res.status(404).end();

  res.setHeader('Content-Type',result.rows[0].image_mime);
  res.setHeader('Cache-Control','private,max-age=3600');
  res.send(result.rows[0].image_data);
});

app.post('/api/flash-catalog', auth, async (req,res) => {
  const parsed = z.object({
    imageData:z.string().min(100),
    title:z.string().max(180).optional().default(''),
    category:z.string().max(80).optional().default('Altro'),
    tags:z.array(z.string().max(60)).max(30).optional().default([]),
    prefix:z.string().regex(/^[A-Z0-9]{2,8}$/).optional().default('WTE'),
    code:z.string().max(40).optional(),
    sortOrder:z.number().int().min(0).max(100000).optional().default(0)
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({error:'Dati del flash non validi.'});
  }

  let decoded;
  try {
    decoded = decodeDataUrl(parsed.data.imageData);
  } catch (error) {
    return res.status(400).json({error:error.message});
  }

  if (!['image/jpeg','image/png','image/webp'].includes(decoded.mime)) {
    return res.status(400).json({error:'Formato immagine non supportato.'});
  }

  if (decoded.buffer.length > 2_000_000) {
    return res.status(413).json({error:'Immagine troppo pesante dopo la compressione.'});
  }

  const code = parsed.data.code?.trim() || await nextFlashCode(parsed.data.prefix);

  try {
    const result = await pool.query(
      `INSERT INTO wte_flash_catalog
       (code,title,category,tags,image_data,image_mime,image_size,sort_order,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,code,title,category,tags,active,sort_order,created_at`,
      [
        code,
        parsed.data.title,
        parsed.data.category,
        parsed.data.tags,
        decoded.buffer,
        decoded.mime,
        decoded.buffer.length,
        parsed.data.sortOrder,
        req.user?.name || req.user?.email || 'Staff'
      ]
    );

    await logActivity(req,'Flash caricato',null,{code,category:parsed.data.category});
    await createNotification(
      'flash_catalog',
      'Nuovo flash aggiunto',
      `${code} è stato aggiunto al catalogo da ${req.user?.name || 'Staff'}.`,
      null,
      null
    );

    res.status(201).json({item:result.rows[0]});
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({error:'Codice flash già esistente.'});
    throw error;
  }
});

app.patch('/api/flash-catalog/:id', auth, async (req,res) => {
  const parsed = z.object({
    code:z.string().max(40).optional(),
    title:z.string().max(180).optional(),
    category:z.string().max(80).optional(),
    tags:z.array(z.string().max(60)).max(30).optional(),
    active:z.boolean().optional(),
    sortOrder:z.number().int().min(0).max(100000).optional(),
    imageData:z.string().min(100).optional()
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({error:'Modifica flash non valida.'});
  }

  const fields = [];
  const values = [];

  const map = {
    code:'code',
    title:'title',
    category:'category',
    tags:'tags',
    active:'active',
    sortOrder:'sort_order'
  };

  let imageReplaced = false;

  for (const [key,value] of Object.entries(parsed.data)) {
    if (key === 'imageData') {
      let decoded;
      try {
        decoded = decodeDataUrl(value);
      } catch (error) {
        return res.status(400).json({error:error.message});
      }

      if (!['image/jpeg','image/png','image/webp'].includes(decoded.mime)) {
        return res.status(400).json({error:'Formato immagine non supportato.'});
      }

      if (decoded.buffer.length > 2_000_000) {
        return res.status(413).json({error:'Immagine troppo pesante dopo la compressione.'});
      }

      values.push(decoded.buffer);
      fields.push(`image_data=$${values.length}`);
      values.push(decoded.mime);
      fields.push(`image_mime=$${values.length}`);
      values.push(decoded.buffer.length);
      fields.push(`image_size=$${values.length}`);
      imageReplaced = true;
      continue;
    }

    values.push(value);
    fields.push(`${map[key]}=$${values.length}`);
  }

  if (!fields.length) return res.status(400).json({error:'Nessuna modifica.'});

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE wte_flash_catalog
       SET ${fields.join(',')},updated_at=NOW()
       WHERE id=$${values.length}
       RETURNING id,code,title,category,tags,active,sort_order,updated_at`,
      values
    );

    if (!result.rowCount) return res.status(404).json({error:'Flash non trovato.'});

    const safeChanges = {...parsed.data};
    if (safeChanges.imageData) safeChanges.imageData='[immagine sostituita]';

    await logActivity(
      req,
      imageReplaced ? 'Immagine flash sostituita' : 'Flash modificato',
      null,
      {id:req.params.id,changes:safeChanges}
    );
    res.json({item:result.rows[0]});
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({error:'Codice flash già esistente.'});
    throw error;
  }
});

app.delete('/api/flash-catalog/:id', auth, async (req,res) => {
  const result = await pool.query(
    'DELETE FROM wte_flash_catalog WHERE id=$1 RETURNING code',
    [req.params.id]
  );

  if (!result.rowCount) return res.status(404).json({error:'Flash non trovato.'});

  await logActivity(req,'Flash eliminato',null,{code:result.rows[0].code});
  res.json({ok:true});
});

app.get('/api/flash-catalog-categories', auth, async (_req,res) => {
  const result = await pool.query(
    `SELECT category,COUNT(*)::int AS count
     FROM wte_flash_catalog
     GROUP BY category ORDER BY category`
  );
  res.json({categories:result.rows});
});



app.get('/api/auth/me', auth, async (req,res) => {
  if (req.user?.legacyOwner) {
    return res.json({
      user:{
        id:null,
        email:req.user.email,
        name:req.user.name,
        role:'admin',
        mustChangePassword:false,
        permissions:req.user.permissions || {}
      }
    });
  }

  const result = await pool.query(
    `SELECT id,email,name,role,enabled,must_change_password,permissions,
            last_login_at,last_login_ip,created_at
     FROM wte_users WHERE id=$1`,
    [req.user.sub]
  );

  if (!result.rowCount || !result.rows[0].enabled) {
    return res.status(401).json({error:'Account non disponibile.'});
  }

  const user=result.rows[0];
  res.json({
    user:{
      id:user.id,email:user.email,name:user.name,role:user.role,
      enabled:user.enabled,
      mustChangePassword:user.must_change_password,
      permissions:user.permissions || {},
      lastLoginAt:user.last_login_at,
      lastLoginIp:user.last_login_ip,
      createdAt:user.created_at
    }
  });
});

app.post('/api/auth/change-password', auth, async (req,res) => {
  if (req.user?.legacyOwner) {
    return res.status(400).json({
      error:'La password proprietario si modifica nelle variabili Environment di Render.'
    });
  }

  const parsed=z.object({
    currentPassword:z.string().min(1),
    newPassword:z.string().min(8).max(120)
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error:'La nuova password deve contenere almeno 8 caratteri.'
    });
  }

  const result=await pool.query(
    'SELECT password_hash FROM wte_users WHERE id=$1 AND enabled=TRUE',
    [req.user.sub]
  );

  if (!result.rowCount ||
      !(await bcrypt.compare(parsed.data.currentPassword,result.rows[0].password_hash))) {
    return res.status(401).json({error:'Password attuale non corretta.'});
  }

  const hash=await bcrypt.hash(parsed.data.newPassword,12);
  await pool.query(
    `UPDATE wte_users
     SET password_hash=$2,must_change_password=FALSE,updated_at=NOW()
     WHERE id=$1`,
    [req.user.sub,hash]
  );

  await logActivity(req,'Password personale modificata');
  res.json({ok:true});
});

app.get('/api/auth/login-history', auth, adminOnly, async (_req,res) => {
  const result=await pool.query(
    `SELECT id,user_id,email,name,role,ip_address,user_agent,success,created_at
     FROM wte_login_log
     ORDER BY created_at DESC LIMIT 200`
  );
  res.json({logins:result.rows});
});

app.get('/api/users', auth, adminOnly, async (_req,res) => {
  const result = await pool.query(
    `SELECT id,email,name,role,enabled,must_change_password,permissions,
            last_login_at,last_login_ip,created_at,updated_at
     FROM wte_users ORDER BY created_at DESC`
  );
  res.json({users:result.rows});
});

app.post('/api/users', auth, adminOnly, async (req,res) => {
  const parsed = z.object({
    email:z.string().email(),
    name:z.string().min(2).max(120),
    password:z.string().min(6).max(120),
    role:z.enum(['admin','collaborator']).default('collaborator')
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({error:'Dati utente non validi.'});

  const hash = await bcrypt.hash(parsed.data.password, 12);
  try {
    const result = await pool.query(
      `INSERT INTO wte_users
       (email,name,password_hash,role,must_change_password,permissions)
       VALUES ($1,$2,$3,$4,TRUE,$5::jsonb)
       RETURNING id,email,name,role,enabled,must_change_password,permissions,created_at`,
      [
        parsed.data.email,parsed.data.name,hash,parsed.data.role,
        JSON.stringify(parsed.data.role === 'admin'
          ? {
              dashboard:true,practices:true,documents:true,payments:true,flash:true,
              notifications:true,settings:true,users:true,delete_practices:true
            }
          : {
              dashboard:true,practices:true,documents:true,payments:true,flash:true,
              notifications:true,settings:false,users:false,delete_practices:false
            }
        )
      ]
    );
    await logActivity(req,'Utente creato',null,{email:parsed.data.email,role:parsed.data.role});
    res.status(201).json({user:result.rows[0]});
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({error:'Email già utilizzata.'});
    throw error;
  }
});

app.patch('/api/users/:id', auth, adminOnly, async (req,res) => {
  const parsed = z.object({
    enabled:z.boolean().optional(),
    role:z.enum(['admin','collaborator']).optional(),
    password:z.string().min(8).max(120).optional(),
    mustChangePassword:z.boolean().optional(),
    permissions:z.record(z.boolean()).optional()
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({error:'Modifica utente non valida.'});

  const updates=[],values=[];
  if (parsed.data.enabled !== undefined) {
    values.push(parsed.data.enabled);updates.push(`enabled=$${values.length}`);
  }
  if (parsed.data.role) {
    values.push(parsed.data.role);updates.push(`role=$${values.length}`);
  }
  if (parsed.data.password) {
    values.push(await bcrypt.hash(parsed.data.password,12));
    updates.push(`password_hash=$${values.length}`);
    values.push(parsed.data.mustChangePassword !== false);
    updates.push(`must_change_password=$${values.length}`);
  } else if (parsed.data.mustChangePassword !== undefined) {
    values.push(parsed.data.mustChangePassword);
    updates.push(`must_change_password=$${values.length}`);
  }
  if (parsed.data.permissions) {
    values.push(JSON.stringify(parsed.data.permissions));
    updates.push(`permissions=$${values.length}::jsonb`);
  }

  if (!updates.length) return res.status(400).json({error:'Nessuna modifica.'});

  values.push(req.params.id);
  const result=await pool.query(
    `UPDATE wte_users
     SET ${updates.join(',')},updated_at=NOW()
     WHERE id=$${values.length}
     RETURNING id,email,name,role,enabled,must_change_password,permissions,
               last_login_at,last_login_ip,updated_at`,
    values
  );

  if (!result.rowCount) return res.status(404).json({error:'Utente non trovato.'});

  await logActivity(req,'Utente modificato',null,{
    userId:req.params.id,
    fields:Object.keys(parsed.data)
  });

  res.json({user:result.rows[0]});
});


app.delete('/api/users/:id', auth, adminOnly, async (req,res) => {
  const result=await pool.query(
    'DELETE FROM wte_users WHERE id=$1 RETURNING email,name',
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({error:'Utente non trovato.'});
  await logActivity(req,'Utente eliminato',null,result.rows[0]);
  res.json({ok:true});
});

app.get('/api/notifications', auth, async (req,res) => {
  const result = await pool.query(
    `SELECT id,type,title,body,practice_id,is_read,created_at
     FROM wte_notifications
     WHERE recipient_role IS NULL OR recipient_role=$1
     ORDER BY created_at DESC LIMIT 100`,
    [req.user.role]
  );
  res.json({notifications:result.rows});
});

app.post('/api/notifications/:id/read', auth, async (req,res) => {
  await pool.query('UPDATE wte_notifications SET is_read=TRUE WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

app.post('/api/notifications/read-all', auth, async (req,res) => {
  await pool.query(
    'UPDATE wte_notifications SET is_read=TRUE WHERE recipient_role IS NULL OR recipient_role=$1',
    [req.user.role]
  );
  res.json({ok:true});
});

app.get('/api/activity', auth, async (_req,res) => {
  const result = await pool.query(
    `SELECT id,actor,actor_role,action,practice_id,details,created_at
     FROM wte_activity_log ORDER BY created_at DESC LIMIT 200`
  );
  res.json({activity:result.rows});
});


function safePdfText(value) {
  return String(value ?? '').replace(/[^\x20-\x7EÀ-ÿ]/g,' ');
}

function euroPdf(value) {
  return new Intl.NumberFormat('it-IT',{
    style:'currency',currency:'EUR',maximumFractionDigits:2
  }).format(Number(value || 0));
}

function practicePayload(row) {
  if (row?.data && typeof row.data === 'object') return row.data;
  if (row?.payload && typeof row.payload === 'object') return row.payload;
  return {};
}

async function flashSessionBundle(token) {
  const sessionResult = await pool.query(
    `SELECT token,practice_id,max_items,selections,customer_name,signature_data,
            accepted_at,locked,expires_at,created_at,updated_at
     FROM wte_flash_sessions WHERE token=$1`,
    [token]
  );
  if (!sessionResult.rowCount) return null;

  const session = sessionResult.rows[0];
  const practiceResult = await pool.query(
    'SELECT id,data,updated_at FROM wte_practices WHERE id=$1',
    [session.practice_id]
  );
  const practiceRow = practiceResult.rows[0] || null;
  const practice = practicePayload(practiceRow);

  const codes = Array.isArray(session.selections) ? session.selections : [];
  let items = [];
  if (codes.length) {
    const result = await pool.query(
      `SELECT id,code,title,category,tags,image_data,image_mime
       FROM wte_flash_catalog
       WHERE code = ANY($1::text[])
       ORDER BY array_position($1::text[],code)`,
      [codes]
    );
    items = result.rows;
  }

  return {session,practice,items};
}

function writePdfHeader(doc, subtitle, practiceId) {
  doc.rect(0,0,doc.page.width,92).fill('#090604');
  doc.fillColor('#D4A64C').font('Helvetica-Bold').fontSize(9)
    .text('WEDDING TATTOO EXPERIENCE',48,28,{characterSpacing:1.6});
  doc.fillColor('#F5EBDD').font('Helvetica').fontSize(23)
    .text(subtitle,48,47);
  doc.fillColor('#7A6C5B').fontSize(8)
    .text(`Pratica ${safePdfText(practiceId)}`,48,76);
  doc.y=112;
}

function writePracticeDetails(doc, practice, session) {
  const rows = [
    ['Cliente',practice.name || session.customer_name || '-'],
    ['Data matrimonio',practice.date || '-'],
    ['Location',practice.location || practice.city || '-'],
    ['Pacchetto',practice.package || practice.packageName || '-'],
    ['Invitati',practice.guests || practice.invited || '-'],
    ['Codice pratica',session.practice_id]
  ];
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#8A5D1B')
    .text('DATI EVENTO');
  doc.moveDown(.45);
  rows.forEach(([label,value])=>{
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#8A7964')
      .text(label.toUpperCase(),{continued:true,width:120});
    doc.font('Helvetica').fontSize(10).fillColor('#211B16')
      .text(`  ${safePdfText(value)}`);
  });
  doc.moveDown(.6);
}

function signatureBuffer(dataUrl) {
  const match=String(dataUrl || '').match(/^data:image\/(?:png|jpeg);base64,(.+)$/);
  return match ? Buffer.from(match[1],'base64') : null;
}

function selectedCodesText(items) {
  return items.map(x=>x.code).join(', ');
}

function buildClientFlashPdf(res,bundle) {
  const {session,practice,items}=bundle;
  const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="WTE_${session.practice_id}_selezione_cliente.pdf"`
  );
  doc.pipe(res);

  writePdfHeader(doc,'Selezione flash confermata',session.practice_id);
  writePracticeDetails(doc,practice,session);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#8A5D1B')
    .text('FLASH SELEZIONATI');
  doc.moveDown(.4);
  doc.font('Helvetica').fontSize(10).fillColor('#211B16')
    .text(`${items.length} flash confermati su un massimo di ${session.max_items}.`);
  doc.moveDown(.25);
  doc.font('Helvetica').fontSize(9).fillColor('#54483C')
    .text(selectedCodesText(items) || '-',{lineGap:3});

  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#8A5D1B')
    .text('DICHIARAZIONE DI ACCETTAZIONE');
  doc.moveDown(.4);
  const terms =
    'Il cliente conferma la selezione dei flash indicati. La selezione definisce '+
    'i soggetti disponibili durante l evento e non garantisce l esecuzione di tutti '+
    'i tatuaggi. Il numero effettivo dipende dalla durata del servizio, dalle '+
    'condizioni operative e dalle richieste degli invitati. Dimensione, posizione e '+
    'fattibilita tecnica sono valutate dal tatuatore. I tatuaggi sono eseguiti '+
    'esclusivamente su persone maggiorenni previa acquisizione del consenso informato.';
  doc.font('Helvetica').fontSize(9.5).fillColor('#211B16')
    .text(terms,{align:'justify',lineGap:3});

  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#8A7964')
    .text('FIRMATARIO');
  doc.font('Helvetica').fontSize(11).fillColor('#211B16')
    .text(safePdfText(session.customer_name || practice.name || '-'));
  doc.font('Helvetica').fontSize(9).fillColor('#54483C')
    .text(`Confermato il ${new Date(session.accepted_at).toLocaleString('it-IT')}`);

  const sig=signatureBuffer(session.signature_data);
  if(sig){
    try{
      doc.image(sig,48,doc.y+12,{fit:[230,85]});
      doc.y+=105;
    }catch{}
  }

  doc.moveDown(.5);
  doc.strokeColor('#C9AD7E').moveTo(48,doc.y).lineTo(310,doc.y).stroke();
  doc.font('Helvetica').fontSize(8).fillColor('#7A6C5B')
    .text('Firma digitale acquisita dal portale Wedding Tattoo Experience',48,doc.y+5);

  doc.end();
}

function buildOperatorFlashPdf(res,bundle) {
  const {session,practice,items}=bundle;
  const doc=new PDFDocument({size:'A4',margin:32,bufferPages:true});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="WTE_${session.practice_id}_scheda_operativa_flash.pdf"`
  );
  doc.pipe(res);

  writePdfHeader(doc,'Scheda operativa flash',session.practice_id);
  writePracticeDetails(doc,practice,session);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#8A5D1B')
    .text(`${items.length} FLASH PRONTI PER IL SERVIZIO`);
  doc.moveDown(.6);

  const cols=3;
  const gap=9;
  const usable=doc.page.width-64;
  const cellW=(usable-gap*(cols-1))/cols;
  const cellH=168;
  let col=0;
  let x=32;
  let y=doc.y;

  items.forEach((item,index)=>{
    if(y+cellH>doc.page.height-45){
      doc.addPage();
      writePdfHeader(doc,'Scheda operativa flash',session.practice_id);
      y=112;col=0;x=32;
    }

    doc.roundedRect(x,y,cellW,cellH-7,3).strokeColor('#CBB793').stroke();
    try{
      doc.image(item.image_data,x+7,y+7,{
        fit:[cellW-14,95],
        align:'center',
        valign:'center'
      });
    }catch{
      doc.font('Helvetica').fontSize(8).fillColor('#7A6C5B')
        .text('Anteprima non disponibile',x+8,y+43,{width:cellW-16,align:'center'});
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#211B16')
      .text(safePdfText(item.code),x+8,y+107,{width:cellW-16,align:'center'});
    doc.font('Helvetica').fontSize(7.5).fillColor('#6F6254')
      .text(safePdfText(item.title || item.category || ''),x+8,y+121,{
        width:cellW-16,align:'center',height:20
      });
    doc.rect(x+10,y+145,9,9).strokeColor('#8A7964').stroke();
    doc.font('Helvetica').fontSize(7).fillColor('#6F6254')
      .text('Eseguito  Invitato: __________________',x+23,y+145,{width:cellW-28});

    col++;
    if(col>=cols){
      col=0;x=32;y+=cellH;
    }else{
      x+=cellW+gap;
    }
  });

  if(col!==0)y+=cellH;
  if(y+145>doc.page.height-45){
    doc.addPage();
    writePdfHeader(doc,'Note operative',session.practice_id);
    y=112;
  }
  doc.y=y;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#8A5D1B')
    .text('NOTE OPERATIVE');
  doc.moveDown(.4);
  for(let i=0;i<7;i++){
    doc.strokeColor('#D6C8B2').moveTo(32,doc.y+13).lineTo(doc.page.width-32,doc.y+13).stroke();
    doc.moveDown(1.15);
  }

  doc.end();
}

app.post('/api/flash-sessions', auth, async (req,res) => {
  const parsed = z.object({
    practiceId:z.string().min(1),
    customerName:z.string().max(180).optional(),
    maxItems:z.number().int().min(1).max(50).default(50),
    expiresAt:z.string().optional(),
    forceNew:z.boolean().optional().default(false)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:'Dati sessione flash non validi.'});

  if (!parsed.data.forceNew) {
    const existing=await pool.query(
      `SELECT token,locked,accepted_at,selections,created_at
       FROM wte_flash_sessions
       WHERE practice_id=$1
       ORDER BY created_at DESC LIMIT 1`,
      [parsed.data.practiceId]
    );
    if(existing.rowCount){
      const row=existing.rows[0];
      const path=`/flash.html?token=${row.token}`;
      return res.json({
        token:row.token,path,
        url:`https://www.weddingtattooexperience.it${path}`,
        existing:true,locked:row.locked,acceptedAt:row.accepted_at,
        count:Array.isArray(row.selections)?row.selections.length:0
      });
    }
  }

  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO wte_flash_sessions
     (token,practice_id,max_items,customer_name,expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [token,parsed.data.practiceId,parsed.data.maxItems,
     parsed.data.customerName||'',parsed.data.expiresAt||null]
  );

  await logActivity(req,'Link flash creato',parsed.data.practiceId,{token});
  await createNotification('flash_link','Link flash creato',
    `È stato creato il link per la selezione flash della pratica ${parsed.data.practiceId}.`,
    parsed.data.practiceId,null);

  const path=`/flash.html?token=${token}`;
  res.status(201).json({
    token,path,
    url:`https://www.weddingtattooexperience.it${path}`,
    existing:false,locked:false,count:0
  });
});

app.get('/api/public/flash-session/:token', async (req,res) => {
  const result = await pool.query(
    `SELECT token,practice_id,max_items,selections,customer_name,signature_data,
            accepted_at,locked,expires_at
     FROM wte_flash_sessions WHERE token=$1`,
    [req.params.token]
  );
  const session=result.rows[0];
  if (!session) return res.status(404).json({error:'Link non valido.'});
  if (session.expires_at && new Date(session.expires_at)<new Date()) {
    return res.status(410).json({error:'Link scaduto.'});
  }
  res.json({session});
});

app.post('/api/public/flash-session/:token', async (req,res) => {
  const parsed = z.object({
    selections:z.array(z.string().min(1)).max(50),
    customerName:z.string().min(2).max(180),
    signatureData:z.string().min(20),
    accepted:z.literal(true)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:'Selezione o firma non valida.'});

  const current=await pool.query(
    'SELECT practice_id,max_items,locked FROM wte_flash_sessions WHERE token=$1',
    [req.params.token]
  );
  if (!current.rowCount) return res.status(404).json({error:'Link non valido.'});
  if (current.rows[0].locked) return res.status(409).json({error:'Selezione già confermata.'});
  if (parsed.data.selections.length>current.rows[0].max_items) {
    return res.status(400).json({error:'Numero massimo di flash superato.'});
  }

  await pool.query(
    `UPDATE wte_flash_sessions
     SET selections=$2::jsonb,customer_name=$3,signature_data=$4,
         accepted_at=NOW(),locked=TRUE,updated_at=NOW()
     WHERE token=$1`,
    [req.params.token,JSON.stringify(parsed.data.selections),
     parsed.data.customerName,parsed.data.signatureData]
  );

  await createNotification('flash_completed','Selezione flash completata',
    `${parsed.data.customerName} ha confermato ${parsed.data.selections.length} flash.`,
    current.rows[0].practice_id,null);

  res.json({
    ok:true,
    count:parsed.data.selections.length,
    clientPdf:`/api/public/flash-session/${req.params.token}/pdf?type=client`,
    operatorPdf:`/api/public/flash-session/${req.params.token}/pdf?type=operator`
  });
});


app.get('/api/public/flash-session/:token/pdf', async (req,res) => {
  const bundle=await flashSessionBundle(req.params.token);
  if(!bundle) return res.status(404).json({error:'Selezione non trovata.'});
  if(!bundle.session.locked || !bundle.session.accepted_at) {
    return res.status(409).json({error:'La selezione non è ancora stata firmata.'});
  }

  const type=String(req.query.type || 'client');
  if(type==='operator') return buildOperatorFlashPdf(res,bundle);
  return buildClientFlashPdf(res,bundle);
});

app.post('/api/flash-sessions/:token/reopen', auth, async (req,res) => {
  const result=await pool.query(
    `UPDATE wte_flash_sessions
     SET locked=FALSE,accepted_at=NULL,signature_data=NULL,updated_at=NOW()
     WHERE token=$1 RETURNING practice_id`,
    [req.params.token]
  );
  if(!result.rowCount) return res.status(404).json({error:'Sessione non trovata.'});
  await logActivity(req,'Selezione flash riaperta',result.rows[0].practice_id,{
    token:req.params.token
  });
  await createNotification(
    'flash_reopened','Selezione flash riaperta',
    `La selezione della pratica ${result.rows[0].practice_id} è stata riaperta.`,
    result.rows[0].practice_id,null
  );
  res.json({ok:true});
});

app.get('/api/flash-sessions/practice/:id', auth, async (req,res) => {
  const result=await pool.query(
    `SELECT token,practice_id,max_items,selections,customer_name,accepted_at,locked,expires_at,created_at
     FROM wte_flash_sessions WHERE practice_id=$1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({sessions:result.rows});
});


app.delete('/api/practices', auth, adminOnly, async (req,res) => {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const countResult=await client.query('SELECT COUNT(*)::int AS count FROM wte_practices');
    const deletedPractices=Number(countResult.rows[0]?.count||0);
    await client.query('DELETE FROM wte_flash_sessions');
    await client.query(
      `DELETE FROM wte_notifications
       WHERE practice_id IS NOT NULL
          OR type IN ('new_practice','flash_link','flash_completed','flash_reopened')`
    );
    await client.query('DELETE FROM wte_activity_log WHERE practice_id IS NOT NULL');
    await client.query('DELETE FROM wte_practices');
    await client.query('COMMIT');

    await logActivity(req,'Archivio pratiche azzerato',null,{deletedPractices});
    res.json({ok:true,deletedPractices});
  }catch(error){
    await client.query('ROLLBACK');
    console.error('Archive reset error',error);
    res.status(500).json({error:'Errore durante l’azzeramento dell’archivio Cloud.'});
  }finally{
    client.release();
  }
});



// ============================================================
// WTE V3 FASE 1 — QR invitati, votazioni e Top 50 automatico
// ============================================================

function validIsoDate(value) {
  const text=String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function guestPublicUrl(token) {
  return `https://www.weddingtattooexperience.it/guest-flash.html?token=${token}`;
}

function guestPdfUrl(token) {
  return `/api/guest-events/${token}/pdf`;
}

async function guestRanking(token, limit=50) {
  const result=await pool.query(
    `SELECT v.flash_code AS code,
            COUNT(*)::int AS votes,
            MIN(v.created_at) AS first_vote,
            COALESCE(c.title,'') AS title,
            COALESCE(c.category,'') AS category,
            c.id AS catalog_id
     FROM wte_guest_votes v
     LEFT JOIN wte_flash_catalog c ON c.code=v.flash_code
     WHERE v.event_token=$1
     GROUP BY v.flash_code,c.title,c.category,c.id
     ORDER BY votes DESC,first_vote ASC,v.flash_code ASC
     LIMIT $2`,
    [token,limit]
  );
  return result.rows;
}

async function guestEventStats(token) {
  const totals=await pool.query(
    `SELECT COUNT(*)::int AS votes,
            COUNT(DISTINCT flash_code)::int AS unique_flash
     FROM wte_guest_votes WHERE event_token=$1`,
    [token]
  );
  return totals.rows[0] || {votes:0,unique_flash:0};
}

async function finalizeGuestEvent(token, reason='automatic') {
  const client=await pool.connect();

  try{
    await client.query('BEGIN');

    const eventResult=await client.query(
      `SELECT token,practice_id,event_date,closes_at,max_flash,status,final_codes
       FROM wte_guest_events
       WHERE token=$1
       FOR UPDATE`,
      [token]
    );

    if(!eventResult.rowCount){
      await client.query('ROLLBACK');
      return null;
    }

    const event=eventResult.rows[0];
    if(event.status==='finalized'){
      await client.query('COMMIT');
      return event;
    }

    const rankingResult=await client.query(
      `SELECT flash_code AS code,COUNT(*)::int AS votes,MIN(created_at) AS first_vote
       FROM wte_guest_votes
       WHERE event_token=$1
       GROUP BY flash_code
       ORDER BY votes DESC,first_vote ASC,flash_code ASC
       LIMIT $2`,
      [token,event.max_flash]
    );

    const finalCodes=rankingResult.rows.map(row=>row.code);

    const updated=await client.query(
      `UPDATE wte_guest_events
       SET status='finalized',
           final_codes=$2::jsonb,
           finalized_at=NOW(),
           updated_at=NOW()
       WHERE token=$1
       RETURNING token,practice_id,event_date,closes_at,max_flash,status,
                 final_codes,finalized_at,created_at,updated_at`,
      [token,JSON.stringify(finalCodes)]
    );

    const publicUrl=guestPublicUrl(token);
    const pdfUrl=guestPdfUrl(token);

    await client.query(
      `UPDATE wte_practices
       SET data=jsonb_set(
         COALESCE(data,'{}'::jsonb),
         '{guestVoting}',
         $2::jsonb,
         TRUE
       ),
       updated_at=NOW()
       WHERE id=$1`,
      [
        event.practice_id,
        JSON.stringify({
          token,
          status:'finalized',
          eventDate:event.event_date,
          closesAt:event.closes_at,
          finalCodes,
          count:finalCodes.length,
          publicUrl,
          pdfUrl,
          finalizedAt:new Date().toISOString()
        })
      ]
    );

    await client.query('COMMIT');

    await workflow.sync(event.practice_id,{
      actor:{type:'system',name:'Selezione invitati'},
      reason:'guest_selection_finalized'
    });

    await createNotification(
      'guest_voting_finalized',
      'Selezione invitati completata',
      `La pratica ${event.practice_id} ha ${finalCodes.length} flash definitivi. Il PDF è pronto.`,
      event.practice_id,
      null
    );

    try{
      await pool.query(
        `INSERT INTO wte_activity_log
         (actor,actor_role,action,practice_id,details)
         VALUES ('Sistema','system','Votazione invitati finalizzata',$1,$2::jsonb)`,
        [event.practice_id,JSON.stringify({token,reason,count:finalCodes.length})]
      );
    }catch{}

    return updated.rows[0];
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{
    client.release();
  }
}

async function finalizeGuestEventIfDue(token) {
  const result=await pool.query(
    `SELECT token,status,closes_at
     FROM wte_guest_events WHERE token=$1`,
    [token]
  );
  const event=result.rows[0];
  if(!event)return null;
  if(event.status==='open' && new Date(event.closes_at)<=new Date()){
    return finalizeGuestEvent(token,'deadline');
  }
  return event;
}

async function finalizeAllDueGuestEvents() {
  const result=await pool.query(
    `SELECT token FROM wte_guest_events
     WHERE status='open' AND closes_at<=NOW()
     ORDER BY closes_at ASC`
  );
  for(const row of result.rows){
    try{ await finalizeGuestEvent(row.token,'scheduled'); }
    catch(error){ console.error('Guest event finalize error',row.token,error); }
  }
}

function writeGuestVotingPdf(res,bundle) {
  const {event,practice,items,ranking}=bundle;
  const doc=new PDFDocument({size:'A4',margin:32,bufferPages:true});

  res.setHeader('Content-Type','application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="WTE_${event.practice_id}_flash_invitati.pdf"`
  );
  doc.pipe(res);

  writePdfHeader(doc,'Flash scelti dagli invitati',event.practice_id);
  writePracticeDetails(doc,practice,{
    practice_id:event.practice_id,
    customer_name:practice.name || ''
  });

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#8A5D1B')
    .text(`${items.length} FLASH DEFINITIVI`);
  doc.font('Helvetica').fontSize(8.5).fillColor('#6F6254')
    .text(
      `Votazione chiusa il ${new Date(event.finalized_at || event.closes_at).toLocaleString('it-IT')}. `+
      `Ordinamento per numero di preferenze.`
    );
  doc.moveDown(.7);

  const votesByCode=new Map(ranking.map(row=>[row.code,Number(row.votes||0)]));
  const cols=3,gap=9,usable=doc.page.width-64;
  const cellW=(usable-gap*(cols-1))/cols;
  const cellH=174;
  let col=0,x=32,y=doc.y;

  items.forEach(item=>{
    if(y+cellH>doc.page.height-42){
      doc.addPage();
      writePdfHeader(doc,'Flash scelti dagli invitati',event.practice_id);
      y=112;col=0;x=32;
    }

    doc.roundedRect(x,y,cellW,cellH-7,3).strokeColor('#CBB793').stroke();

    try{
      doc.image(item.image_data,x+7,y+7,{
        fit:[cellW-14,102],align:'center',valign:'center'
      });
    }catch{
      doc.font('Helvetica').fontSize(8).fillColor('#7A6C5B')
        .text('Anteprima non disponibile',x+8,y+48,{
          width:cellW-16,align:'center'
        });
    }

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#211B16')
      .text(safePdfText(item.code),x+8,y+114,{
        width:cellW-16,align:'center'
      });
    doc.font('Helvetica').fontSize(7.5).fillColor('#6F6254')
      .text(safePdfText(item.title || item.category || ''),x+8,y+128,{
        width:cellW-16,align:'center',height:18
      });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#8A5D1B')
      .text(`${votesByCode.get(item.code)||0} preferenze`,x+8,y+149,{
        width:cellW-16,align:'center'
      });

    col++;
    if(col>=cols){col=0;x=32;y+=cellH}
    else{x+=cellW+gap}
  });

  doc.end();
}

app.post('/api/guest-events', auth, async (req,res) => {
  const parsed=z.object({
    practiceId:z.string().min(1),
    eventDate:z.string().optional(),
    maxFlash:z.number().int().min(1).max(50).optional().default(50)
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Dati evento invitati non validi.'});
  }

  const practiceResult=await pool.query(
    'SELECT id,data FROM wte_practices WHERE id=$1',
    [parsed.data.practiceId]
  );
  if(!practiceResult.rowCount){
    return res.status(404).json({error:'Pratica non trovata.'});
  }

  const practice=practiceResult.rows[0].data || {};
  const eventDate=validIsoDate(parsed.data.eventDate || practice.date);
  if(!eventDate){
    return res.status(400).json({
      error:'Inserisci una data evento valida nella pratica (AAAA-MM-GG).'
    });
  }

  const existing=await pool.query(
    `SELECT token,practice_id,event_date,closes_at,max_flash,status,final_codes,
            finalized_at,created_at,updated_at
     FROM wte_guest_events WHERE practice_id=$1`,
    [parsed.data.practiceId]
  );

  if(existing.rowCount){
    const event=await finalizeGuestEventIfDue(existing.rows[0].token);
    const stats=await guestEventStats(existing.rows[0].token);
    return res.json({
      event:{...existing.rows[0],...(event||{})},
      stats,
      url:guestPublicUrl(existing.rows[0].token),
      qr:`${req.protocol}://${req.get('host')}/api/public/guest-event/${existing.rows[0].token}/qr.svg`,
      existing:true
    });
  }

  const token=crypto.randomBytes(24).toString('hex');
  const result=await pool.query(
    `INSERT INTO wte_guest_events
     (token,practice_id,event_date,closes_at,max_flash)
     VALUES (
       $1,$2,$3::date,
       (($3::date - 15) AT TIME ZONE 'Europe/Rome'),
       $4
     )
     RETURNING token,practice_id,event_date,closes_at,max_flash,status,
               final_codes,finalized_at,created_at,updated_at`,
    [token,parsed.data.practiceId,eventDate,parsed.data.maxFlash]
  );

  const event=result.rows[0];
  const url=guestPublicUrl(token);

  await pool.query(
    `UPDATE wte_practices
     SET data=jsonb_set(
       COALESCE(data,'{}'::jsonb),
       '{guestVoting}',
       $2::jsonb,
       TRUE
     ),
     updated_at=NOW()
     WHERE id=$1`,
    [
      parsed.data.practiceId,
      JSON.stringify({
        token,
        status:'open',
        eventDate,
        closesAt:event.closes_at,
        publicUrl:url,
        qrUrl:`https://wte-cloud-api.onrender.com/api/public/guest-event/${token}/qr.svg`
      })
    ]
  );

  await logActivity(req,'QR invitati creato',parsed.data.practiceId,{
    token,eventDate,closesAt:event.closes_at
  });
  await createNotification(
    'guest_voting_created',
    'QR invitati pronto',
    `Il catalogo invitati della pratica ${parsed.data.practiceId} è aperto fino al ${new Date(event.closes_at).toLocaleDateString('it-IT')}.`,
    parsed.data.practiceId,
    null
  );

  res.status(201).json({
    event,
    stats:{votes:0,unique_flash:0},
    url,
    qr:`${req.protocol}://${req.get('host')}/api/public/guest-event/${token}/qr.svg`,
    existing:false
  });
});

app.get('/api/guest-events/practice/:id', auth, async (req,res) => {
  const result=await pool.query(
    `SELECT token,practice_id,event_date,closes_at,max_flash,status,final_codes,
            finalized_at,created_at,updated_at
     FROM wte_guest_events WHERE practice_id=$1`,
    [req.params.id]
  );

  if(!result.rowCount){
    return res.json({event:null,ranking:[],stats:{votes:0,unique_flash:0}});
  }

  const token=result.rows[0].token;
  const checked=await finalizeGuestEventIfDue(token);
  const fresh=await pool.query(
    `SELECT token,practice_id,event_date,closes_at,max_flash,status,final_codes,
            finalized_at,created_at,updated_at
     FROM wte_guest_events WHERE token=$1`,
    [token]
  );
  const ranking=await guestRanking(token,50);
  const stats=await guestEventStats(token);

  res.json({
    event:fresh.rows[0] || checked,
    ranking,
    stats,
    url:guestPublicUrl(token),
    qr:`${req.protocol}://${req.get('host')}/api/public/guest-event/${token}/qr.svg`,
    pdf:`${req.protocol}://${req.get('host')}${guestPdfUrl(token)}`
  });
});

app.post('/api/guest-events/:token/finalize', auth, adminOnly, async (req,res) => {
  const event=await finalizeGuestEvent(req.params.token,'manual');
  if(!event)return res.status(404).json({error:'Evento invitati non trovato.'});
  const ranking=await guestRanking(req.params.token,50);
  res.json({ok:true,event,ranking});
});

app.get('/api/guest-events/:token/pdf', auth, async (req,res) => {
  await finalizeGuestEventIfDue(req.params.token);

  const result=await pool.query(
    `SELECT practice_id,status
     FROM wte_guest_events
     WHERE token=$1`,
    [req.params.token]
  );

  if(!result.rowCount){
    return res.status(404).json({error:'Evento invitati non trovato.'});
  }

  if(result.rows[0].status!=='finalized'){
    return res.status(409).json({
      error:'La votazione non è ancora chiusa.'
    });
  }

  return pdfEngine.render(
    'flash_selection',
    result.rows[0].practice_id,
    {res}
  );
});

app.get('/api/public/guest-event/:token', async (req,res) => {
  // Durante il collaudo da 1 € lasciamo aperta anche una votazione già scaduta,
  // così possiamo provare realmente la scelta flash senza alterare la regola
  // definitiva dei 15 giorni. Tornando STRIPE_ONE_EURO_TEST=false,
  // il comportamento normale viene ripristinato automaticamente.
  if(!STRIPE_ONE_EURO_TEST){
    await finalizeGuestEventIfDue(req.params.token);
  }

  const result=await pool.query(
    `SELECT ge.token,ge.practice_id,ge.event_date,ge.closes_at,ge.max_flash,
            ge.status,ge.final_codes,ge.finalized_at,
            COALESCE(p.data->>'name','') AS customer_name,
            COALESCE(p.data->>'partner1','') AS partner1,
            COALESCE(p.data->>'partner2','') AS partner2,
            COALESCE(p.data->>'location','') AS location
     FROM wte_guest_events ge
     LEFT JOIN wte_practices p ON p.id=ge.practice_id
     WHERE ge.token=$1`,
    [req.params.token]
  );
  if(!result.rowCount){
    return res.status(404).json({error:'QR non valido.'});
  }

  const event=result.rows[0];
  const stats=await guestEventStats(req.params.token);

  res.json({
    event:{
      eventDate:event.event_date,
      closesAt:event.closes_at,
      maxFlash:event.max_flash,
      status:STRIPE_ONE_EURO_TEST?'open':event.status,
      finalizedAt:event.finalized_at,
      finalCount:Array.isArray(event.final_codes)?event.final_codes.length:0,
      customerName:event.customer_name||'',
      partner1:event.partner1||'',
      partner2:event.partner2||'',
      location:event.location||'',
      testMode:Boolean(STRIPE_ONE_EURO_TEST)
    },
    stats
  });
});

app.get('/api/public/guest-event/:token/qr.svg', async (req,res) => {
  const result=await pool.query(
    'SELECT token FROM wte_guest_events WHERE token=$1',
    [req.params.token]
  );
  if(!result.rowCount)return res.status(404).end();

  const svg=await QRCode.toString(guestPublicUrl(req.params.token),{
    type:'svg',
    width:640,
    margin:2,
    color:{dark:'#090604',light:'#FFFFFF'}
  });

  res.setHeader('Content-Type','image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control','public,max-age=3600');
  res.send(svg);
});

app.get('/api/public/guest-event/:token/vote', async (req,res) => {
  const voterKey=String(req.query.voterKey || '').trim();
  if(!voterKey)return res.json({vote:null});

  const result=await pool.query(
    `SELECT flash_code,updated_at
     FROM wte_guest_votes
     WHERE event_token=$1 AND voter_key=$2`,
    [req.params.token,voterKey]
  );
  res.json({vote:result.rows[0] || null});
});

app.post('/api/public/guest-event/:token/vote', publicRateLimit, async (req,res) => {
  const parsed=z.object({
    voterKey:z.string().min(12).max(160),
    flashCode:z.string().min(1).max(40)
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Preferenza non valida.'});
  }

  const eventResult=await pool.query(
    `SELECT token,status,closes_at FROM wte_guest_events WHERE token=$1`,
    [req.params.token]
  );
  if(!eventResult.rowCount){
    return res.status(404).json({error:'QR non valido.'});
  }

  let event=eventResult.rows[0];

  if(!STRIPE_ONE_EURO_TEST){
    if(event.status==='open' && new Date(event.closes_at)<=new Date()){
      await finalizeGuestEvent(req.params.token,'vote-deadline');
      event.status='finalized';
    }

    if(event.status!=='open'){
      return res.status(409).json({
        error:'La selezione degli invitati è chiusa.'
      });
    }
  }

  const flashResult=await pool.query(
    `SELECT code FROM wte_flash_catalog
     WHERE code=$1 AND active=TRUE`,
    [parsed.data.flashCode]
  );
  if(!flashResult.rowCount){
    return res.status(404).json({error:'Flash non disponibile.'});
  }

  await pool.query(
    `INSERT INTO wte_guest_votes
     (event_token,voter_key,flash_code)
     VALUES ($1,$2,$3)
     ON CONFLICT (event_token,voter_key)
     DO UPDATE SET flash_code=EXCLUDED.flash_code,updated_at=NOW()`,
    [req.params.token,parsed.data.voterKey,parsed.data.flashCode]
  );

  const stats=await guestEventStats(req.params.token);
  res.json({
    ok:true,
    vote:{flash_code:parsed.data.flashCode},
    stats
  });
});

setTimeout(()=>{
  finalizeAllDueGuestEvents().catch(error=>
    console.error('Initial guest finalize error',error)
  );
},5000);

setInterval(()=>{
  finalizeAllDueGuestEvents().catch(error=>
    console.error('Scheduled guest finalize error',error)
  );
},60*60*1000);



// ============================================================
// WTE V3 FASE 2 — pagamenti, ricevute e scadenze automatiche
// ============================================================

function cents(value) {
  const number=Number(value);
  return Number.isFinite(number) ? Math.max(0,Math.round(number)) : 0;
}

function euroFromCents(value) {
  return new Intl.NumberFormat('it-IT',{
    style:'currency',currency:'EUR'
  }).format(cents(value)/100);
}

function paymentPublicUrl(token) {
  return `https://www.weddingtattooexperience.it/payment.html?token=${token}`;
}

function safeEventDate(value) {
  const text=String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function calculateBalanceDueAt(eventDate) {
  const date=safeEventDate(eventDate);
  if(!date)return null;
  return `${date}T00:00:00+02:00`;
}

async function paymentPlanByPractice(practiceId) {
  const result=await pool.query(
    `SELECT practice_id,token,currency,total_cents,deposit_cents,balance_cents,
            deposit_due_at,balance_due_at,deposit_payment_url,balance_payment_url,
            deposit_status,balance_status,deposit_paid_at,balance_paid_at,
            deposit_provider,balance_provider,deposit_reference,balance_reference,
            deposit_receipt_url,balance_receipt_url,
            stripe_deposit_session_id,stripe_balance_session_id,stripe_customer_id,
            reminder_30_sent_at,reminder_7_sent_at,created_at,updated_at
     FROM wte_payment_plans WHERE practice_id=$1`,
    [practiceId]
  );
  return result.rows[0] || null;
}

async function paymentPlanByToken(token) {
  const result=await pool.query(
    `SELECT practice_id,token,currency,total_cents,deposit_cents,balance_cents,
            deposit_due_at,balance_due_at,deposit_payment_url,balance_payment_url,
            deposit_status,balance_status,deposit_paid_at,balance_paid_at,
            deposit_provider,balance_provider,deposit_reference,balance_reference,
            deposit_receipt_url,balance_receipt_url,
            stripe_deposit_session_id,stripe_balance_session_id,stripe_customer_id,
            reminder_30_sent_at,reminder_7_sent_at,created_at,updated_at
     FROM wte_payment_plans WHERE token=$1`,
    [token]
  );
  return result.rows[0] || null;
}

async function practiceContact(practiceId) {
  const result=await pool.query(
    'SELECT data FROM wte_practices WHERE id=$1',
    [practiceId]
  );
  const practice=result.rows[0]?.data || {};
  return {
    practice,
    email:String(practice.email || practice.mail || '').trim(),
    phone:String(practice.phone || practice.telefono || '').trim(),
    name:String(practice.name || '').trim()
  };
}

async function queueMessage({
  practiceId=null,
  messageType,
  recipient='',
  subject='',
  body,
  sendAfter=new Date(),
  metadata={}
}) {
  const result=await pool.query(
    `INSERT INTO wte_message_outbox
     (practice_id,message_type,recipient,subject,body,send_after,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id,practice_id,message_type,recipient,subject,body,status,
               send_after,created_at`,
    [
      practiceId,messageType,recipient,subject,body,sendAfter,
      JSON.stringify(metadata)
    ]
  );
  return result.rows[0];
}

async function ensureGuestVotingAfterDeposit(practiceId) {
  const practiceResult=await pool.query(
    'SELECT data FROM wte_practices WHERE id=$1',
    [practiceId]
  );
  if(!practiceResult.rowCount)return null;

  const practice=practiceResult.rows[0].data || {};
  const eventDate=safeEventDate(practice.date);
  if(!eventDate)return null;

  const existing=await pool.query(
    'SELECT token FROM wte_guest_events WHERE practice_id=$1',
    [practiceId]
  );
  if(existing.rowCount)return existing.rows[0];

  const token=crypto.randomBytes(24).toString('hex');
  const result=await pool.query(
    `INSERT INTO wte_guest_events
     (token,practice_id,event_date,closes_at,max_flash)
     VALUES (
       $1,$2,$3::date,
       (($3::date - 15) AT TIME ZONE 'Europe/Rome'),
       50
     )
     RETURNING token,practice_id,event_date,closes_at,status`,
    [token,practiceId,eventDate]
  );

  const event=result.rows[0];
  const url=guestPublicUrl(token);

  await pool.query(
    `UPDATE wte_practices
     SET data=jsonb_set(
       COALESCE(data,'{}'::jsonb),
       '{guestVoting}',
       $2::jsonb,
       TRUE
     ),
     updated_at=NOW()
     WHERE id=$1`,
    [
      practiceId,
      JSON.stringify({
        token,
        status:'open',
        eventDate,
        closesAt:event.closes_at,
        publicUrl:url,
        qrUrl:`https://wte-cloud-api.onrender.com/api/public/guest-event/${token}/qr.svg`
      })
    ]
  );

  await createNotification(
    'guest_voting_created',
    'QR invitati creato automaticamente',
    `L’acconto della pratica ${practiceId} è stato registrato. Il QR invitati è pronto.`,
    practiceId,
    null
  );

  return event;
}

async function updatePracticePaymentSummary(practiceId,plan) {
  const ready=plan.deposit_status==='paid'
    && plan.balance_status==='paid';

  await pool.query(
    `UPDATE wte_practices
     SET data=jsonb_set(
       COALESCE(data,'{}'::jsonb),
       '{payments}',
       $2::jsonb,
       TRUE
     ),
     updated_at=NOW()
     WHERE id=$1`,
    [
      practiceId,
      JSON.stringify({
        token:plan.token,
        publicUrl:paymentPublicUrl(plan.token),
        currency:plan.currency,
        totalCents:plan.total_cents,
        depositCents:plan.deposit_cents,
        balanceCents:plan.balance_cents,
        depositStatus:plan.deposit_status,
        balanceStatus:plan.balance_status,
        depositPaidAt:plan.deposit_paid_at,
        balancePaidAt:plan.balance_paid_at,
        depositReceiptUrl:plan.deposit_receipt_url,
        balanceReceiptUrl:plan.balance_receipt_url,
        ready
      })
    ]
  );
}

async function applyPaidPayment({
  practiceId,
  paymentType,
  amountCents=0,
  provider='manual',
  reference='',
  receiptUrl='',
  eventKey='',
  occurredAt=new Date(),
  payload={}
}) {
  const plan=await paymentPlanByPractice(practiceId);
  if(!plan)throw new Error('Piano pagamenti non trovato.');

  const type=paymentType==='balance'?'balance':'deposit';
  const key=eventKey || `${provider}:${practiceId}:${type}:${reference || occurredAt.toISOString()}`;

  const client=await pool.connect();
  try{
    await client.query('BEGIN');

    const existing=await client.query(
      'SELECT id FROM wte_payment_events WHERE event_key=$1',
      [key]
    );
    if(existing.rowCount){
      await client.query('COMMIT');
      return paymentPlanByPractice(practiceId);
    }

    await client.query(
      `INSERT INTO wte_payment_events
       (event_key,practice_id,payment_type,status,amount_cents,currency,
        provider,provider_reference,receipt_url,payload,occurred_at)
       VALUES ($1,$2,$3,'paid',$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        key,practiceId,type,cents(amountCents),plan.currency,
        provider,reference,receiptUrl,JSON.stringify(payload),occurredAt
      ]
    );

    const statusColumn=type==='deposit'?'deposit_status':'balance_status';
    const paidColumn=type==='deposit'?'deposit_paid_at':'balance_paid_at';
    const providerColumn=type==='deposit'?'deposit_provider':'balance_provider';
    const referenceColumn=type==='deposit'?'deposit_reference':'balance_reference';
    const receiptColumn=type==='deposit'?'deposit_receipt_url':'balance_receipt_url';

    await client.query(
      `UPDATE wte_payment_plans
       SET ${statusColumn}='paid',
           ${paidColumn}=$2,
           ${providerColumn}=$3,
           ${referenceColumn}=$4,
           ${receiptColumn}=$5,
           updated_at=NOW()
       WHERE practice_id=$1`,
      [practiceId,occurredAt,provider,reference,receiptUrl]
    );

    await client.query('COMMIT');
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{
    client.release();
  }

  const updated=await paymentPlanByPractice(practiceId);
  await syncBookingStatus(practiceId);
  await updatePracticePaymentSummary(practiceId,updated);
  await workflow.sync(practiceId,{
    actor:{type:'system',name:'Pagamento automatico'},
    reason:type==='deposit'?'deposit_paid':'balance_paid'
  });

  if(type==='deposit'){
    await ensureGuestVotingAfterDeposit(practiceId);

    const couplePlan=await paymentPlanByPractice(practiceId);
    await notifications.queueForPractice(
      practiceId,
      'deposit_paid',
      {
        context:{
          practiceId,
          depositCents:couplePlan?.deposit_cents||0,
          coupleUrl:couplePlan
            ?couplePublicUrl(couplePlan.couple_token||couplePlan.token)
            :''
        },
        idempotencyKey:`deposit_paid:${practiceId}`
      }
    );
    const contact=await practiceContact(practiceId);
    const guestEvent=await pool.query(
      'SELECT token FROM wte_guest_events WHERE practice_id=$1',
      [practiceId]
    );
    const guestUrl=guestEvent.rowCount
      ? guestPublicUrl(guestEvent.rows[0].token)
      : '';

    if(guestUrl){
      await notifications.queueForPractice(
        practiceId,
        'guest_qr_ready',
        {
          context:{practiceId,guestUrl},
          idempotencyKey:`guest_qr_ready:${practiceId}`
        }
      );
    }

    await queueMessage({
      practiceId,
      messageType:'deposit_paid',
      recipient:contact.email || contact.phone,
      subject:'Acconto ricevuto — Wedding Tattoo Experience',
      body:
        `Ciao ${contact.name || ''}, abbiamo registrato il tuo acconto. `+
        (guestUrl
          ? `Il catalogo invitati è disponibile qui: ${guestUrl}`
          : 'La pratica è stata aggiornata.'),
      metadata:{paymentType:type,guestUrl}
    });
  }else{
    const paidPlan=await paymentPlanByPractice(practiceId);
    await notifications.queueForPractice(
      practiceId,
      'balance_paid',
      {
        context:{
          practiceId,
          balanceCents:paidPlan?.balance_cents||0,
          coupleUrl:paidPlan
            ?couplePublicUrl(paidPlan.couple_token||paidPlan.token)
            :''
        },
        idempotencyKey:`balance_paid:${practiceId}`
      }
    );

    const contact=await practiceContact(practiceId);
    await queueMessage({
      practiceId,
      messageType:'balance_paid',
      recipient:contact.email || contact.phone,
      subject:'Saldo ricevuto — Wedding Tattoo Experience',
      body:
        `Ciao ${contact.name || ''}, abbiamo registrato il saldo. `+
        'La pratica del matrimonio risulta pronta.',
      metadata:{paymentType:type}
    });
  }

  await createNotification(
    type==='deposit'?'deposit_paid':'balance_paid',
    type==='deposit'?'Acconto ricevuto':'Saldo ricevuto',
    `${euroFromCents(amountCents)} registrati per la pratica ${practiceId}.`,
    practiceId,
    null
  );

  return updated;
}

function writePaymentReceiptPdf(res,{plan,practice,paymentType}) {
  const type=paymentType==='balance'?'balance':'deposit';
  const isDeposit=type==='deposit';
  const amount=isDeposit?plan.deposit_cents:plan.balance_cents;
  const paidAt=isDeposit?plan.deposit_paid_at:plan.balance_paid_at;
  const provider=isDeposit?plan.deposit_provider:plan.balance_provider;
  const reference=isDeposit?plan.deposit_reference:plan.balance_reference;

  const doc=new PDFDocument({size:'A4',margin:48});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="WTE_${plan.practice_id}_${type}_pagamento.pdf"`
  );
  doc.pipe(res);

  writePdfHeader(
    doc,
    isDeposit?'Registrazione acconto':'Registrazione saldo',
    plan.practice_id
  );

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#8A5D1B')
    .text(isDeposit?'ACCONTO REGISTRATO':'SALDO REGISTRATO');
  doc.moveDown(.7);

  const rows=[
    ['Cliente',practice.name || '-'],
    ['Data evento',practice.date || '-'],
    ['Luogo',practice.location || practice.city || '-'],
    ['Importo',euroFromCents(amount)],
    ['Data pagamento',paidAt?new Date(paidAt).toLocaleString('it-IT'):'-'],
    ['Metodo / provider',provider || '-'],
    ['Riferimento',reference || '-'],
    ['Pratica',plan.practice_id]
  ];

  rows.forEach(([label,value])=>{
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#8A7964')
      .text(label.toUpperCase(),{continued:true,width:150});
    doc.font('Helvetica').fontSize(10).fillColor('#211B16')
      .text(`  ${safePdfText(value)}`);
    doc.moveDown(.25);
  });

  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(8.5).fillColor('#6F6254')
    .text(
      'Documento generato automaticamente dal gestionale Wedding Tattoo Experience. '+
      'Attesta la registrazione del pagamento nella pratica e non sostituisce eventuali '+
      'documenti fiscali previsti dalla normativa applicabile.',
      {lineGap:3}
    );

  doc.end();
}

async function processPaymentReminders() {
  const result=await pool.query(
    `SELECT p.practice_id,p.token,p.balance_cents,p.balance_due_at,
            p.balance_payment_url,p.reminder_30_sent_at,p.reminder_7_sent_at,
            r.data
     FROM wte_payment_plans p
     LEFT JOIN wte_practices r ON r.id=p.practice_id
     WHERE p.balance_status='pending'
       AND p.balance_due_at IS NOT NULL`
  );

  const now=new Date();

  for(const row of result.rows){
    const eventDate=safeEventDate(row.data?.date);
    if(!eventDate)continue;

    const event=new Date(`${eventDate}T12:00:00+02:00`);
    const days=Math.ceil((event-now)/86400000);
    const contact={
      name:String(row.data?.name||'').trim(),
      recipient:String(row.data?.email||row.data?.mail||row.data?.phone||'').trim()
    };

    if(days<=30 && days>7 && !row.reminder_30_sent_at){
      await queueMessage({
        practiceId:row.practice_id,
        messageType:'balance_reminder_30',
        recipient:contact.recipient,
        subject:'Promemoria saldo — Wedding Tattoo Experience',
        body:
          `Ciao ${contact.name}, manca circa un mese al matrimonio. `+
          `Il saldo di ${euroFromCents(row.balance_cents)} dovrà essere versato `+
          `entro la settimana precedente l’evento. `+
          (row.balance_payment_url?`Pagamento: ${row.balance_payment_url}`:''),
        metadata:{daysBeforeEvent:days}
      });
      await pool.query(
        'UPDATE wte_payment_plans SET reminder_30_sent_at=NOW(),updated_at=NOW() WHERE practice_id=$1',
        [row.practice_id]
      );
      await createNotification(
        'balance_reminder_30',
        'Promemoria saldo preparato',
        `Preparato il promemoria saldo per la pratica ${row.practice_id}.`,
        row.practice_id,
        null
      );
    }

    if(days<=7 && !row.reminder_7_sent_at){
      await queueMessage({
        practiceId:row.practice_id,
        messageType:'balance_due_7',
        recipient:contact.recipient,
        subject:'Saldo in scadenza — Wedding Tattoo Experience',
        body:
          `Ciao ${contact.name}, il saldo di ${euroFromCents(row.balance_cents)} `+
          `è ora dovuto prima dell’evento. `+
          (row.balance_payment_url?`Pagamento: ${row.balance_payment_url}`:''),
        metadata:{daysBeforeEvent:days}
      });
      await pool.query(
        'UPDATE wte_payment_plans SET reminder_7_sent_at=NOW(),updated_at=NOW() WHERE practice_id=$1',
        [row.practice_id]
      );
      await createNotification(
        'balance_due_7',
        'Saldo in scadenza',
        `Il saldo della pratica ${row.practice_id} è da completare.`,
        row.practice_id,
        null
      );
    }
  }
}

app.post('/api/payment-plans', auth, async (req,res) => {
  const parsed=z.object({
    practiceId:z.string().min(1),
    totalCents:z.number().int().min(0),
    depositCents:z.number().int().min(0),
    depositDueAt:z.string().optional().nullable(),
    depositPaymentUrl:z.string().url().optional().or(z.literal('')),
    balancePaymentUrl:z.string().url().optional().or(z.literal(''))
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Dati piano pagamenti non validi.'});
  }

  const practiceResult=await pool.query(
    'SELECT data FROM wte_practices WHERE id=$1',
    [parsed.data.practiceId]
  );
  if(!practiceResult.rowCount){
    return res.status(404).json({error:'Pratica non trovata.'});
  }

  const practice=practiceResult.rows[0].data || {};
  const total=cents(parsed.data.totalCents);
  const deposit=Math.min(total,cents(parsed.data.depositCents));
  const balance=Math.max(0,total-deposit);
  const eventDate=safeEventDate(practice.date);
  const balanceDue=eventDate
    ? new Date(new Date(`${eventDate}T12:00:00+02:00`).getTime()-7*86400000)
    : null;

  const existing=await paymentPlanByPractice(parsed.data.practiceId);
  const token=existing?.token || crypto.randomBytes(24).toString('hex');

  const result=await pool.query(
    `INSERT INTO wte_payment_plans
     (practice_id,token,couple_token,total_cents,deposit_cents,balance_cents,
      deposit_due_at,balance_due_at,deposit_payment_url,balance_payment_url,
      booking_status)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,'deposit_pending')
     ON CONFLICT (practice_id)
     DO UPDATE SET
       total_cents=EXCLUDED.total_cents,
       deposit_cents=EXCLUDED.deposit_cents,
       balance_cents=EXCLUDED.balance_cents,
       deposit_due_at=EXCLUDED.deposit_due_at,
       balance_due_at=EXCLUDED.balance_due_at,
       deposit_payment_url=EXCLUDED.deposit_payment_url,
       balance_payment_url=EXCLUDED.balance_payment_url,
       updated_at=NOW()
     RETURNING practice_id,token,currency,total_cents,deposit_cents,balance_cents,
               deposit_due_at,balance_due_at,deposit_payment_url,balance_payment_url,
               deposit_status,balance_status,deposit_paid_at,balance_paid_at,
               deposit_provider,balance_provider,deposit_reference,balance_reference,
               deposit_receipt_url,balance_receipt_url,
               reminder_30_sent_at,reminder_7_sent_at,created_at,updated_at`,
    [
      parsed.data.practiceId,token,total,deposit,balance,
      parsed.data.depositDueAt || null,balanceDue,
      parsed.data.depositPaymentUrl || '',
      parsed.data.balancePaymentUrl || ''
    ]
  );

  const plan=result.rows[0];
  await updatePracticePaymentSummary(parsed.data.practiceId,plan);
  await logActivity(req,'Piano pagamenti salvato',parsed.data.practiceId,{
    totalCents:total,depositCents:deposit,balanceCents:balance
  });

  res.status(existing?200:201).json({
    plan,
    publicUrl:paymentPublicUrl(token)
  });
});

app.get('/api/payment-plans/practice/:id', auth, async (req,res) => {
  const plan=await paymentPlanByPractice(req.params.id);
  if(!plan)return res.json({plan:null,events:[],outbox:[]});

  const events=await pool.query(
    `SELECT id,event_key,payment_type,status,amount_cents,currency,provider,
            provider_reference,receipt_url,occurred_at,created_at
     FROM wte_payment_events
     WHERE practice_id=$1
     ORDER BY occurred_at DESC`,
    [req.params.id]
  );

  const outbox=await pool.query(
    `SELECT id,message_type,recipient,subject,body,status,send_after,sent_at,created_at
     FROM wte_message_outbox
     WHERE practice_id=$1
     ORDER BY created_at DESC LIMIT 20`,
    [req.params.id]
  );

  res.json({
    plan,
    events:events.rows,
    outbox:outbox.rows,
    publicUrl:paymentPublicUrl(plan.token),
    depositReceipt:`${req.protocol}://${req.get('host')}/api/payment-plans/${plan.practice_id}/receipt?type=deposit`,
    balanceReceipt:`${req.protocol}://${req.get('host')}/api/payment-plans/${plan.practice_id}/receipt?type=balance`
  });
});

app.post('/api/payment-plans/:id/mark-paid', auth, async (req,res) => {
  const parsed=z.object({
    type:z.enum(['deposit','balance']),
    amountCents:z.number().int().min(0).optional(),
    provider:z.string().max(80).optional().default('manual'),
    reference:z.string().max(180).optional().default(''),
    receiptUrl:z.string().url().optional().or(z.literal(''))
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Pagamento non valido.'});
  }

  const plan=await paymentPlanByPractice(req.params.id);
  if(!plan)return res.status(404).json({error:'Piano pagamenti non trovato.'});

  const defaultAmount=parsed.data.type==='deposit'
    ? plan.deposit_cents
    : plan.balance_cents;

  const updated=await applyPaidPayment({
    practiceId:req.params.id,
    paymentType:parsed.data.type,
    amountCents:parsed.data.amountCents ?? defaultAmount,
    provider:parsed.data.provider,
    reference:parsed.data.reference,
    receiptUrl:parsed.data.receiptUrl || '',
    eventKey:`manual:${req.params.id}:${parsed.data.type}:${Date.now()}`,
    payload:{actor:req.user?.email||req.user?.name||'Staff'}
  });

  await logActivity(req,'Pagamento registrato',req.params.id,{
    type:parsed.data.type,
    amountCents:parsed.data.amountCents ?? defaultAmount
  });

  res.json({ok:true,plan:updated});
});

app.get('/api/payment-plans/:id/receipt', auth, async (req,res) => {
  const type=String(req.query.type||'deposit')==='balance'
    ?'balance_receipt'
    :'deposit_receipt';

  const plan=await paymentPlanByPractice(req.params.id);
  if(!plan)return res.status(404).json({error:'Piano pagamenti non trovato.'});

  const status=type==='deposit_receipt'
    ?plan.deposit_status
    :plan.balance_status;

  if(status!=='paid'){
    return res.status(409).json({
      error:'Il pagamento non risulta ancora registrato.'
    });
  }

  return pdfEngine.render(type,req.params.id,{res});
});


function stripeSuccessUrl(token) {
  return `${PUBLIC_SITE_URL}/success.html?token=${encodeURIComponent(token)}`+
    `&session_id={CHECKOUT_SESSION_ID}`;
}

function stripeCancelUrl(token) {
  return `${PUBLIC_SITE_URL}/payment.html?token=${encodeURIComponent(token)}`+
    `&cancelled=1`;
}

async function createStripeCheckoutSession(plan,paymentType) {
  if(!stripe){
    const error=new Error('Stripe non configurato.');
    error.statusCode=503;
    throw error;
  }

  const type=paymentType==='balance'?'balance':'deposit';
  const realAmount=type==='deposit'
    ?Number(plan.deposit_cents||0)
    :Number(plan.balance_cents||0);
  const amount=(STRIPE_ONE_EURO_TEST && type==='deposit')
    ?100
    :realAmount;

  const status=type==='deposit'
    ?plan.deposit_status
    :plan.balance_status;

  if(status==='paid'){
    const error=new Error('Questo pagamento risulta già completato.');
    error.statusCode=409;
    throw error;
  }

  if(amount<50){
    const error=new Error('Importo Stripe non valido.');
    error.statusCode=400;
    throw error;
  }

  const contact=await practiceContact(plan.practice_id);
  const label=type==='deposit'
    ?(STRIPE_ONE_EURO_TEST?'TEST 1€ · Acconto Wedding Tattoo Experience':'Acconto Wedding Tattoo Experience')
    :'Saldo Wedding Tattoo Experience';

  const session=await stripe.checkout.sessions.create({
    mode:'payment',
    locale:'it',
    customer_email:contact.email||undefined,
    success_url:stripeSuccessUrl(plan.token),
    cancel_url:stripeCancelUrl(plan.token),
    client_reference_id:plan.practice_id,
    line_items:[{
      quantity:1,
      price_data:{
        currency:STRIPE_CURRENCY,
        unit_amount:amount,
        product_data:{
          name:label,
          description:[
            contact.practice.name||'',
            contact.practice.date||'',
            contact.practice.location||contact.practice.city||''
          ].filter(Boolean).join(' · ')
        }
      }
    }],
    metadata:{
      practiceId:plan.practice_id,
      paymentType:type,
      paymentToken:plan.token,
      testOneEuro:STRIPE_ONE_EURO_TEST && type==='deposit' ? 'true' : 'false',
      realAmountCents:String(realAmount)
    },
    payment_intent_data:{
      metadata:{
        practiceId:plan.practice_id,
        paymentType:type,
        paymentToken:plan.token,
        testOneEuro:STRIPE_ONE_EURO_TEST && type==='deposit' ? 'true' : 'false',
        realAmountCents:String(realAmount)
      }
    }
  });

  const sessionColumn=
    type==='deposit'
      ?'stripe_deposit_session_id'
      :'stripe_balance_session_id';
  const urlColumn=
    type==='deposit'
      ?'deposit_payment_url'
      :'balance_payment_url';

  await pool.query(
    `UPDATE wte_payment_plans
     SET ${sessionColumn}=$2,
         ${urlColumn}=$3,
         updated_at=NOW()
     WHERE practice_id=$1`,
    [plan.practice_id,session.id,session.url||'']
  );

  return session;
}

app.post('/api/public/payment-plan/:token/checkout', async (req,res) => {
  try{
    await releaseManager.assertBookingAllowed();
  }catch(error){
    return res.status(error.statusCode||503).json({
      error:error.message,
      code:error.code||'BOOKING_DISABLED'
    });
  }

  const parsed=z.object({
    type:z.enum(['deposit','balance'])
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Tipo pagamento non valido.'});
  }

  try{
    const plan=await paymentPlanByToken(req.params.token);
    if(!plan){
      return res.status(404).json({error:'Link pagamento non valido.'});
    }

    if(
      parsed.data.type==='balance' &&
      plan.deposit_status!=='paid'
    ){
      return res.status(409).json({
        error:'Il saldo sarà disponibile dopo la registrazione dell’acconto.'
      });
    }

    if(parsed.data.type==='deposit'){
      await dateAvailability.ensureCheckoutAllowed(plan.practice_id);
    }

    const session=await createStripeCheckoutSession(
      plan,
      parsed.data.type
    );

    return res.status(201).json({
      checkoutUrl:session.url,
      sessionId:session.id
    });
  }catch(error){
    console.error('Stripe checkout error',error);
    return res.status(error.statusCode||500).json({
      error:error.message||'Impossibile avviare Stripe Checkout.'
    });
  }
});

app.get('/api/public/stripe-session/:sessionId', async (req,res) => {
  if(!stripe){
    return res.status(503).json({error:'Stripe non configurato.'});
  }

  try{
    const session=await stripe.checkout.sessions.retrieve(
      req.params.sessionId
    );

    const practiceId=String(session.metadata?.practiceId||'');
    const paymentType=
      session.metadata?.paymentType==='balance'?'balance':'deposit';

    // Fallback di riconciliazione:
    // se Stripe conferma il pagamento ma il webhook è in ritardo o ha fallito,
    // la pagina di successo registra comunque il pagamento in modo idempotente.
    if(session.payment_status==='paid' && practiceId){
      let receiptUrl='';
      let providerReference=String(session.payment_intent||session.id);

      if(session.payment_intent){
        try{
          const paymentIntent=await stripe.paymentIntents.retrieve(
            String(session.payment_intent),
            {expand:['latest_charge']}
          );
          const charge=paymentIntent.latest_charge;
          if(charge && typeof charge!=='string'){
            receiptUrl=String(charge.receipt_url||'');
            providerReference=String(charge.id||paymentIntent.id);
          }
        }catch(error){
          console.error('Stripe reconciliation receipt error',error.message);
        }
      }

      await applyPaidPayment({
        practiceId,
        paymentType,
        amountCents:Number(session.amount_total||0),
        provider:'stripe',
        reference:providerReference,
        receiptUrl,
        eventKey:`stripe-session-reconcile:${session.id}`,
        occurredAt:new Date(),
        payload:{
          checkoutSessionId:session.id,
          paymentIntentId:String(session.payment_intent||''),
          reconciliation:true
        }
      });

      if(paymentType==='deposit'){
        await dateAvailability.confirmForPractice(practiceId,{
          provider:'stripe',
          checkoutSessionId:session.id,
          reconciliation:true
        });
      }
    }

    return res.json({
      id:session.id,
      status:session.status,
      paymentStatus:session.payment_status,
      practiceId,
      paymentType,
      reconciled:session.payment_status==='paid' && Boolean(practiceId)
    });
  }catch(error){
    console.error('Stripe session reconciliation error',error);
    return res.status(404).json({error:'Sessione Stripe non trovata.'});
  }
});


app.get('/api/public/payment-plan/:token', async (req,res) => {
  const plan=await paymentPlanByToken(req.params.token);
  if(!plan)return res.status(404).json({error:'Link pagamento non valido.'});

  const contact=await practiceContact(plan.practice_id);
  res.json({
    plan:{
      currency:plan.currency,
      totalCents:plan.total_cents,
      depositCents:plan.deposit_cents,
      balanceCents:plan.balance_cents,
      depositDueAt:plan.deposit_due_at,
      balanceDueAt:plan.balance_due_at,
      depositPaymentUrl:plan.deposit_payment_url,
      balancePaymentUrl:plan.balance_payment_url,
      depositStatus:plan.deposit_status,
      balanceStatus:plan.balance_status,
      depositPaidAt:plan.deposit_paid_at,
      balancePaidAt:plan.balance_paid_at
    },
    practice:{
      name:contact.practice.name||'',
      date:contact.practice.date||'',
      location:contact.practice.location||contact.practice.city||''
    }
  });
});

app.post('/api/payment-webhook/:provider', async (req,res) => {
  if(!PAYMENT_WEBHOOK_SECRET){
    return res.status(503).json({
      error:'Webhook pagamenti non configurato.'
    });
  }

  const signature=String(req.headers['x-wte-signature']||'');
  const body=JSON.stringify(req.body||{});
  const expected=crypto
    .createHmac('sha256',PAYMENT_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  const valid=
    signature.length===expected.length
    && crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected));

  if(!valid){
    return res.status(401).json({error:'Firma webhook non valida.'});
  }

  const parsed=z.object({
    eventId:z.string().min(1).max(240),
    practiceId:z.string().min(1).max(160),
    type:z.enum(['deposit','balance']),
    status:z.enum(['paid','pending','failed','cancelled']),
    amountCents:z.number().int().min(0),
    currency:z.string().max(8).optional().default('EUR'),
    reference:z.string().max(240).optional().default(''),
    receiptUrl:z.string().url().optional().or(z.literal('')),
    paidAt:z.string().optional()
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Payload webhook non valido.'});
  }

  if(parsed.data.status!=='paid'){
    await pool.query(
      `INSERT INTO wte_payment_events
       (event_key,practice_id,payment_type,status,amount_cents,currency,
        provider,provider_reference,receipt_url,payload,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
       ON CONFLICT (event_key) DO NOTHING`,
      [
        parsed.data.eventId,parsed.data.practiceId,parsed.data.type,
        parsed.data.status,parsed.data.amountCents,parsed.data.currency,
        req.params.provider,parsed.data.reference,parsed.data.receiptUrl||'',
        JSON.stringify(req.body)
      ]
    );
    return res.json({ok:true,processed:false});
  }

  const updated=await applyPaidPayment({
    practiceId:parsed.data.practiceId,
    paymentType:parsed.data.type,
    amountCents:parsed.data.amountCents,
    provider:req.params.provider,
    reference:parsed.data.reference,
    receiptUrl:parsed.data.receiptUrl||'',
    eventKey:parsed.data.eventId,
    occurredAt:parsed.data.paidAt?new Date(parsed.data.paidAt):new Date(),
    payload:req.body
  });

  res.json({ok:true,processed:true,plan:updated});
});

app.get('/api/message-outbox', auth, async (req,res) => {
  const result=await pool.query(
    `SELECT id,practice_id,message_type,recipient,subject,body,status,
            send_after,sent_at,metadata,created_at
     FROM wte_message_outbox
     ORDER BY created_at DESC LIMIT 200`
  );
  res.json({messages:result.rows});
});

app.post('/api/message-outbox/:id/sent', auth, async (req,res) => {
  const result=await pool.query(
    `UPDATE wte_message_outbox
     SET status='sent',sent_at=NOW()
     WHERE id=$1
     RETURNING id,status,sent_at`,
    [req.params.id]
  );
  if(!result.rowCount)return res.status(404).json({error:'Messaggio non trovato.'});
  res.json({message:result.rows[0]});
});

setTimeout(()=>{
  processPaymentReminders().catch(error=>
    console.error('Initial payment reminder error',error)
  );
},7000);

setInterval(()=>{
  processPaymentReminders().catch(error=>
    console.error('Scheduled payment reminder error',error)
  );
},60*60*1000);



// ============================================================
// WTE V3 FASE 3 — assistente pacchetto, contratto e firma
// ============================================================

function salesPublicUrl(token) {
  return `https://www.weddingtattooexperience.it/contract.html?token=${token}`;
}

function absoluteApiUrl(path='') {
  const clean=String(path||'').startsWith('/')?String(path):`/${path}`;
  return `${PUBLIC_API_URL}${clean}`;
}

function contractPdfUrl(token) {
  return `/api/public/contracts/${token}/pdf`;
}

function safeCustomerText(value,max=240) {
  return String(value || '').trim().slice(0,max);
}

async function activePackages() {
  const result=await pool.query(
    `SELECT code,name,description,reason,price_cents,deposit_percent,
            included_hours,min_guests,max_guests,max_distance_km,
            features,sort_order
     FROM wte_service_packages
     WHERE active=TRUE
     ORDER BY sort_order ASC`
  );
  return result.rows;
}

function rulePackageCode(data) {
  const guests=Number(data.guests||0);
  const hours=Number(data.hours||0);
  const distance=Number(data.distance||0);
  const style=String(data.style||'').toLowerCase();

  if(guests>150 || hours>=8 || distance>180 || style==='premium'){
    return 'LUXURY';
  }
  if(guests>110 || hours>=6 || distance>100){
    return 'GOLD';
  }
  if(guests>65 || hours>=4 || style==='equilibrato'){
    return 'SILVER';
  }
  return 'BRONZE';
}

function deterministicRecommendation(data,packages) {
  const code=rulePackageCode(data);
  const selected=packages.find(item=>item.code===code) || packages[0];
  const facts=[
    `${Number(data.guests||0)} invitati`,
    `${Number(data.hours||0)} ore richieste`,
    `${Number(data.distance||0)} km di distanza`
  ];
  return {
    packageCode:selected.code,
    packageName:selected.name,
    title:`Pacchetto ${selected.name} consigliato`,
    explanation:
      `${selected.reason} La valutazione considera ${facts.join(', ')}.`,
    considerations:[
      Number(data.guests||0)>110?'Affluenza elevata':'Affluenza gestibile',
      Number(data.hours||0)>=6?'Durata estesa':'Durata standard',
      Number(data.distance||0)>100?'Trasferta significativa':'Trasferta ordinaria'
    ],
    source:'rules'
  };
}

function outputTextFromResponse(payload) {
  if(typeof payload?.output_text==='string')return payload.output_text;
  for(const item of payload?.output||[]){
    if(item?.type!=='message')continue;
    for(const content of item.content||[]){
      if(content?.type==='output_text' && typeof content.text==='string'){
        return content.text;
      }
    }
  }
  return '';
}

async function aiRecommendation(data,packages,fallback) {
  if(!OPENAI_API_KEY)return {...fallback,aiUsed:false};

  const packageList=packages.map(item=>({
    code:item.code,
    name:item.name,
    priceCents:item.price_cents,
    includedHours:Number(item.included_hours),
    minGuests:item.min_guests,
    maxGuests:item.max_guests,
    maxDistanceKm:item.max_distance_km,
    reason:item.reason
  }));

  const schema={
    type:'object',
    additionalProperties:false,
    properties:{
      packageCode:{type:'string',enum:packageList.map(item=>item.code)},
      title:{type:'string'},
      explanation:{type:'string'},
      considerations:{
        type:'array',
        items:{type:'string'},
        minItems:2,
        maxItems:5
      }
    },
    required:['packageCode','title','explanation','considerations']
  };

  // L'AI è un miglioramento, non deve mai bloccare la proposta.
  // Se OpenAI non risponde rapidamente, il chiamante userà il fallback deterministico.
  const aiController=new AbortController();
  const aiTimeout=setTimeout(()=>aiController.abort(),6000);

  let response;
  try{
    response=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{
        Authorization:`Bearer ${OPENAI_API_KEY}`,
        'Content-Type':'application/json'
      },
      signal:aiController.signal,
      body:JSON.stringify({
      model:OPENAI_MODEL,
      store:false,
      input:[
        {
          role:'system',
          content:
            'Sei il consulente Wedding Tattoo Experience. '+
            'Scegli esclusivamente uno dei pacchetti forniti. '+
            'Non inventare prezzi, condizioni o servizi. '+
            'Scrivi in italiano, con tono chiaro e professionale. '+
            'La raccomandazione deve ridurre dubbi e passaggi del cliente.'
        },
        {
          role:'user',
          content:JSON.stringify({
            customer:data,
            availablePackages:packageList,
            deterministicFallback:fallback.packageCode
          })
        }
      ],
      text:{
        format:{
          type:'json_schema',
          name:'wte_package_recommendation',
          strict:true,
          schema
        }
      },
        max_output_tokens:500
      })
    });
  }catch(error){
    if(error?.name==='AbortError'){
      throw new Error('OpenAI timeout: uso raccomandazione automatica.');
    }
    throw error;
  }finally{
    clearTimeout(aiTimeout);
  }

  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    throw new Error(payload?.error?.message || `OpenAI ${response.status}`);
  }

  const text=outputTextFromResponse(payload);
  const parsed=JSON.parse(text);
  const selected=packages.find(item=>item.code===parsed.packageCode);
  if(!selected)throw new Error('Pacchetto AI non valido.');

  return {
    packageCode:selected.code,
    packageName:selected.name,
    title:parsed.title,
    explanation:parsed.explanation,
    considerations:parsed.considerations,
    source:'openai',
    aiUsed:true
  };
}

function defaultContractClauses() {
  return [
    {
      title:'Oggetto del servizio',
      text:
        'Wedding Tattoo Experience fornirà il servizio indicato nel pacchetto scelto, '+
        'secondo i dati dell’evento riportati nel presente documento.'
    },
    {
      title:'Acconto e conferma della data',
      text:
        'La data è considerata confermata soltanto dopo la registrazione dell’acconto. '+
        'Le istruzioni e la scadenza del pagamento sono riportate nella pagina pagamenti.'
    },
    {
      title:'Saldo',
      text:
        'Il saldo deve risultare registrato entro sette giorni prima dell’evento, '+
        'salvo diverso accordo scritto.'
    },
    {
      title:'Catalogo flash e invitati',
      text:
        'Dopo la registrazione dell’acconto viene attivato il QR invitati. '+
        'La raccolta delle preferenze termina automaticamente quindici giorni prima '+
        'dell’evento e genera la selezione definitiva fino a cinquanta flash.'
    },
    {
      title:'Esecuzione del tatuaggio',
      text:
        'Ogni tatuaggio è subordinato alla maggiore età, al consenso informato, '+
        'alla valutazione professionale del tatuatore e alle condizioni operative '+
        'disponibili durante l’evento.'
    },
    {
      title:'Variazioni e comunicazioni',
      text:
        'Eventuali variazioni rilevanti di data, luogo, orario o organizzazione devono '+
        'essere comunicate tempestivamente e possono richiedere una revisione economica.'
    }
  ];
}

function contractNumber() {
  const date=new Date();
  const stamp=[
    date.getFullYear(),
    String(date.getMonth()+1).padStart(2,'0'),
    String(date.getDate()).padStart(2,'0')
  ].join('');
  return `WTE-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function contractSignatureBuffer(dataUrl) {
  const match=String(dataUrl||'').match(/^data:image\/(?:png|jpeg);base64,(.+)$/);
  return match?Buffer.from(match[1],'base64'):null;
}

async function salesBundleByContractToken(token) {
  const result=await pool.query(
    `SELECT c.token,c.sales_token,c.practice_id,c.package_code,c.contract_number,
            c.customer_data,c.package_snapshot,c.clauses,c.status,c.signer_name,
            c.signature_data,c.accepted_at,c.created_at,c.updated_at,
            s.recommendation,s.ai_used,s.ai_summary
     FROM wte_contracts c
     JOIN wte_sales_sessions s ON s.token=c.sales_token
     WHERE c.token=$1`,
    [token]
  );
  return result.rows[0] || null;
}

function writeContractPdf(res,bundle) {
  const customer=bundle.customer_data||{};
  const pack=bundle.package_snapshot||{};
  const clauses=Array.isArray(bundle.clauses)?bundle.clauses:[];
  const accepted=bundle.status==='accepted';

  const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${bundle.contract_number}_${accepted?'firmato':'bozza'}.pdf"`
  );
  doc.pipe(res);

  writePdfHeader(
    doc,
    accepted?'Contratto accettato':'Bozza di contratto',
    bundle.contract_number
  );

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#8A5D1B')
    .text('DATI DEL CLIENTE E DELL’EVENTO');
  doc.moveDown(.5);

  const rows=[
    ['Cliente',customer.name||'-'],
    ['E-mail',customer.email||'-'],
    ['Telefono',customer.phone||'-'],
    ['Data evento',customer.date||'-'],
    ['Ora',customer.time||'-'],
    ['Luogo',customer.location||'-'],
    ['Invitati',customer.guests||'-'],
    ['Pacchetto',pack.name||bundle.package_code],
    ['Importo',pack.price_cents?euroFromCents(pack.price_cents):'Su misura']
  ];

  rows.forEach(([label,value])=>{
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#8A7964')
      .text(label.toUpperCase(),{continued:true,width:125});
    doc.font('Helvetica').fontSize(10).fillColor('#211B16')
      .text(`  ${safePdfText(value)}`);
  });

  doc.moveDown(1);
  clauses.forEach((clause,index)=>{
    if(doc.y>doc.page.height-130)doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#8A5D1B')
      .text(`${index+1}. ${safePdfText(clause.title)}`);
    doc.moveDown(.25);
    doc.font('Helvetica').fontSize(9).fillColor('#211B16')
      .text(safePdfText(clause.text),{align:'justify',lineGap:3});
    doc.moveDown(.65);
  });

  doc.moveDown(.5);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#8A5D1B')
    .text(accepted?'ACCETTAZIONE REGISTRATA':'DOCUMENTO IN BOZZA');
  doc.moveDown(.35);

  if(accepted){
    doc.font('Helvetica').fontSize(9).fillColor('#211B16')
      .text(
        `Firmatario: ${safePdfText(bundle.signer_name)}\n`+
        `Data e ora: ${new Date(bundle.accepted_at).toLocaleString('it-IT')}`
      );

    const signature=contractSignatureBuffer(bundle.signature_data);
    if(signature){
      try{
        doc.image(signature,48,doc.y+12,{fit:[250,85]});
        doc.y+=108;
      }catch{}
    }
  }else{
    doc.font('Helvetica').fontSize(9).fillColor('#6F6254')
      .text(
        'Questa è una bozza generata automaticamente. Il contratto sarà considerato '+
        'accettato soltanto dopo la conferma delle condizioni e l’acquisizione della firma.'
      );
  }

  doc.end();
}

async function createPaymentPlanFromContract(practiceId,customer,pack) {
  const total=cents(pack.price_cents||0);
  const depositPercent=Number(pack.deposit_percent||30);
  const deposit=Math.round(total*depositPercent/100);
  const balance=Math.max(0,total-deposit);
  const eventDate=safeEventDate(customer.date);
  const balanceDue=eventDate
    ? new Date(new Date(`${eventDate}T12:00:00+02:00`).getTime()-7*86400000)
    : null;
  const depositDue=new Date(Date.now()+3*86400000);
  const existing=await paymentPlanByPractice(practiceId);
  const token=existing?.token || crypto.randomBytes(24).toString('hex');

  const result=await pool.query(
    `INSERT INTO wte_payment_plans
     (practice_id,token,couple_token,total_cents,deposit_cents,balance_cents,
      deposit_due_at,balance_due_at,booking_status)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'deposit_pending')
     ON CONFLICT (practice_id)
     DO UPDATE SET
       total_cents=EXCLUDED.total_cents,
       deposit_cents=EXCLUDED.deposit_cents,
       balance_cents=EXCLUDED.balance_cents,
       deposit_due_at=EXCLUDED.deposit_due_at,
       balance_due_at=EXCLUDED.balance_due_at,
       updated_at=NOW()
     RETURNING practice_id,token,currency,total_cents,deposit_cents,balance_cents,
               deposit_due_at,balance_due_at,deposit_payment_url,balance_payment_url,
               deposit_status,balance_status,deposit_paid_at,balance_paid_at,
               deposit_provider,balance_provider,deposit_reference,balance_reference,
               deposit_receipt_url,balance_receipt_url,
               reminder_30_sent_at,reminder_7_sent_at,created_at,updated_at`,
    [practiceId,token,total,deposit,balance,depositDue,balanceDue]
  );

  await updatePracticePaymentSummary(practiceId,result.rows[0]);
  return result.rows[0];
}

app.get('/api/public/packages', async (_req,res) => {
  res.setHeader('Cache-Control','no-store');
  const packages=await activePackages();
  res.json({
    packages:packages.map(item=>({
      ...item,
      priceLabel:item.price_cents?euroFromCents(item.price_cents):'Su misura'
    }))
  });
});


// ============================================================
// WTE Release 1.0 Punto 3 — Disponibilità date
// ============================================================


// ============================================================
// WTE Release 1.0 Punto 4 — stato pubblico e diagnostica
// ============================================================

app.get('/api/public/release-status', async (_req,res) => {
  try{
    const report=await releaseDiagnostics.run();

    res.setHeader('Cache-Control','no-store');
    res.status(report.ok?200:503).json({
      ok:report.ok,
      release:report.release,
      environment:report.environment,
      services:{
        website:true,
        api:Boolean(report.checks.database?.ok),
        database:Boolean(report.checks.database?.ok),
        payments:Boolean(report.checks.configuration?.checks?.stripeSecretKey),
        automations:Boolean(report.checks.modules?.scheduler),
        documents:Boolean(report.checks.modules?.pdfEngine),
        dateProtection:Boolean(report.checks.modules?.dateAvailability)
      },
      checkedAt:report.finishedAt
    });
  }catch(error){
    res.status(503).json({
      ok:false,
      error:'Stato del servizio temporaneamente non disponibile.'
    });
  }
});


app.get('/api/public/release-info', async (_req,res) => {
  try{
    const state=await releaseManager.current();
    res.setHeader('Cache-Control','no-store');
    res.json({
      release:state.release_name,
      maintenance:state.maintenance_enabled,
      message:state.maintenance_message,
      bookingEnabled:state.booking_enabled,
      updatedAt:state.updated_at
    });
  }catch(error){
    res.status(503).json({
      error:'Informazioni release non disponibili.'
    });
  }
});

app.get('/api/release/control', auth, adminOnly, async (_req,res) => {
  try{
    const [control,deployments,backupCounts]=await Promise.all([
      releaseManager.current(),
      releaseManager.deployments(30),
      releaseBackup.counts()
    ]);
    res.json({control,deployments,backupCounts});
  }catch(error){
    res.status(500).json({error:error.message});
  }
});

app.post('/api/release/maintenance', auth, adminOnly, async (req,res) => {
  try{
    const control=await releaseManager.setMaintenance(
      Boolean(req.body?.enabled),
      {
        message:String(req.body?.message||''),
        updatedBy:req.user?.email||req.user?.name||'admin'
      }
    );
    res.json({control});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'RELEASE_ERROR'
    });
  }
});

app.post('/api/release/bookings', auth, adminOnly, async (req,res) => {
  try{
    const control=await releaseManager.setBooking(
      Boolean(req.body?.enabled),
      {
        updatedBy:req.user?.email||req.user?.name||'admin'
      }
    );
    res.json({control});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'RELEASE_ERROR'
    });
  }
});

app.get('/api/release/backup', auth, adminOnly, async (req,res) => {
  try{
    const backup=await releaseBackup.exportJson({
      includeSensitive:String(req.query.sensitive||'false')==='true'
    });

    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${backup.filename}"`
    );
    res.setHeader('X-WTE-Checksum-SHA256',backup.checksum);
    res.send(backup.json);
  }catch(error){
    res.status(500).json({error:error.message});
  }
});

app.post('/api/release/rollback', auth, adminOnly, async (req,res) => {
  try{
    const result=await releaseManager.markRollback({
      targetDeploymentId:String(req.body?.targetDeploymentId||''),
      updatedBy:req.user?.email||req.user?.name||'admin',
      notes:String(req.body?.notes||'')
    });
    res.status(201).json(result);
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'RELEASE_ERROR'
    });
  }
});


app.get('/api/release/diagnostics', auth, adminOnly, async (_req,res) => {
  try{
    const report=await releaseDiagnostics.run();
    res.status(report.ok?200:503).json(report);
  }catch(error){
    res.status(500).json({
      ok:false,
      error:error.message||'Diagnostica non disponibile.'
    });
  }
});



// ============================================================
// WTE Release 2 - Fase 5: conversion analytics
// ============================================================

app.post('/api/public/analytics/event', publicRateLimit, async (req,res) => {
  try{
    const result=await conversionAnalytics.record({
      eventName:String(req.body?.eventName||''),
      sessionId:String(req.body?.sessionId||''),
      visitorId:String(req.body?.visitorId||''),
      path:String(req.body?.path||''),
      referrerHost:String(req.body?.referrerHost||''),
      metadata:
        req.body?.metadata &&
        typeof req.body.metadata==='object'
          ? req.body.metadata
          : {},
      occurredAt:req.body?.occurredAt||null
    });

    res.status(result.recorded?201:200).json({
      ok:true,
      recorded:result.recorded
    });
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'ANALYTICS_ERROR'
    });
  }
});

app.get('/api/analytics/overview', auth, adminOnly, async (req,res) => {
  try{
    const data=await conversionAnalytics.overview(
      Number(req.query.days||30)
    );
    res.json(data);
  }catch(error){
    res.status(500).json({error:error.message});
  }
});



// ============================================================
// WTE Manager — Offerte e sconti programmati
// ============================================================
app.get('/api/offers', auth, async (_req,res) => {
  await ensureOffersSchema();
  const result=await pool.query(
    `SELECT * FROM wte_offers
     ORDER BY active DESC,
              COALESCE(start_date,CURRENT_DATE) DESC,
              id DESC`
  );
  res.json({offers:result.rows.map(offerRow)});
});

app.post('/api/offers', auth, async (req,res) => {
  await ensureOffersSchema();

  const parsed=z.object({
    title:z.string().min(1).max(120),
    type:z.enum(['percent','fixed','gift']),
    value:z.coerce.number().min(0).default(0),
    gift:z.string().max(180).optional().default(''),
    startDate:z.string().nullable().optional(),
    endDate:z.string().nullable().optional(),
    scope:z.enum(['global','personal']).default('global'),
    clientId:z.string().nullable().optional(),
    clientName:z.string().nullable().optional(),
    message:z.string().max(600).optional().default(''),
    showPopup:z.boolean().default(true),
    active:z.boolean().default(true)
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Offerta non valida.'});
  }

  const o=parsed.data;
  if(o.startDate&&o.endDate&&o.endDate<o.startDate){
    return res.status(400).json({error:'Intervallo date non valido.'});
  }

  const result=await pool.query(
    `INSERT INTO wte_offers
     (title,type,value,gift,start_date,end_date,scope,
      client_id,client_name,message,show_popup,active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      o.title,o.type,o.value,o.gift,
      o.startDate||null,o.endDate||null,o.scope,
      o.scope==='personal'?(o.clientId||null):null,
      o.scope==='personal'?(o.clientName||null):null,
      o.message,o.showPopup,o.active
    ]
  );

  res.status(201).json({offer:offerRow(result.rows[0])});
});

app.patch('/api/offers/:id', auth, async (req,res) => {
  await ensureOffersSchema();

  const parsed=z.object({
    title:z.string().min(1).max(120),
    type:z.enum(['percent','fixed','gift']),
    value:z.coerce.number().min(0).default(0),
    gift:z.string().max(180).optional().default(''),
    startDate:z.string().nullable().optional(),
    endDate:z.string().nullable().optional(),
    scope:z.enum(['global','personal']).default('global'),
    clientId:z.string().nullable().optional(),
    clientName:z.string().nullable().optional(),
    message:z.string().max(600).optional().default(''),
    showPopup:z.boolean().default(true),
    active:z.boolean().default(true)
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Offerta non valida.'});
  }

  const o=parsed.data;
  if(o.startDate&&o.endDate&&o.endDate<o.startDate){
    return res.status(400).json({error:'Intervallo date non valido.'});
  }

  const result=await pool.query(
    `UPDATE wte_offers
     SET title=$2,type=$3,value=$4,gift=$5,
         start_date=$6,end_date=$7,scope=$8,
         client_id=$9,client_name=$10,message=$11,
         show_popup=$12,active=$13,updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [
      req.params.id,o.title,o.type,o.value,o.gift,
      o.startDate||null,o.endDate||null,o.scope,
      o.scope==='personal'?(o.clientId||null):null,
      o.scope==='personal'?(o.clientName||null):null,
      o.message,o.showPopup,o.active
    ]
  );

  if(!result.rowCount){
    return res.status(404).json({error:'Offerta non trovata.'});
  }

  res.json({offer:offerRow(result.rows[0])});
});

app.delete('/api/offers/:id', auth, async (req,res) => {
  await ensureOffersSchema();
  await pool.query('DELETE FROM wte_offers WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

app.get('/api/public/offers/active', publicRateLimit, async (_req,res) => {
  await ensureOffersSchema();

  const result=await pool.query(
    `SELECT *
     FROM wte_offers
     WHERE active=TRUE
       AND scope='global'
       AND show_popup=TRUE
       AND (start_date IS NULL OR start_date<=CURRENT_DATE)
       AND (end_date IS NULL OR end_date>=CURRENT_DATE)
     ORDER BY
       COALESCE(end_date,CURRENT_DATE+INTERVAL '100 years') ASC,
       id DESC
     LIMIT 1`
  );

  res.json({
    offer:result.rowCount?offerRow(result.rows[0]):null
  });
});

app.get('/api/public/availability/:date', publicRateLimit, async (req,res) => {
  try{
    const result=await dateAvailability.check(req.params.date,{
      holdToken:String(req.query.holdToken||'')
    });
    res.setHeader('Cache-Control','no-store');
    res.json(result);
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'AVAILABILITY_ERROR'
    });
  }
});

app.get('/api/date-reservations', auth, async (req,res) => {
  try{
    const reservations=await dateAvailability.list({
      from:String(req.query.from||''),
      to:String(req.query.to||''),
      status:String(req.query.status||''),
      limit:Number(req.query.limit||200)
    });
    res.json({reservations});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'AVAILABILITY_ERROR'
    });
  }
});

app.post('/api/date-reservations/:practiceId/release', auth, adminOnly, async (req,res) => {
  try{
    const reservation=await dateAvailability.release({
      practiceId:req.params.practiceId,
      reason:String(req.body?.reason||'rilasciata_dallo_staff')
    });
    res.json({reservation});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'AVAILABILITY_ERROR'
    });
  }
});


app.post('/api/public/advisor/recommend', publicRateLimit, async (req,res) => {
  try{
    await releaseManager.assertBookingAllowed();
  }catch(error){
    return res.status(error.statusCode||503).json({
      error:error.message,
      code:error.code||'BOOKING_DISABLED'
    });
  }

  const parsed=z.object({
    name:z.string().min(2).max(180),
    email:z.string().email(),
    phone:z.string().min(5).max(60),
    date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time:z.string().max(20).optional().default(''),
    location:z.string().min(2).max(240),
    guests:z.number().int().min(1).max(5000),
    experience:z.enum(['intimo','equilibrato','premium']).optional(),
    budget:z.enum(['under1000','1000-1500','1500-2200','over2200']).optional(),
    hours:z.number().min(1).max(24).optional(),
    distance:z.number().min(0).max(5000).optional(),
    style:z.enum(['intimo','equilibrato','premium']).optional(),
    notes:z.string().max(2000).optional().default('')
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({
      error:'Completa correttamente tutti i dati dell’evento.'
    });
  }

  const availability=await dateAvailability.check(parsed.data.date,{
    holdToken:String(req.body?.holdToken||'')
  });
  if(!availability.available){
    return res.status(409).json({
      error:'La data scelta non è più disponibile. Seleziona un altro giorno.',
      code:'DATE_NOT_AVAILABLE'
    });
  }

  const packages=await activePackages();
  if(!packages.length){
    return res.status(503).json({error:'Pacchetti non configurati.'});
  }

  const inferredStyle=parsed.data.experience || parsed.data.style || 'equilibrato';
  const inferredHours=parsed.data.hours || (
    inferredStyle==='premium' ? 7 :
    parsed.data.guests>110 ? 6 :
    parsed.data.guests>65 ? 5 : 3
  );
  const inferredDistance=parsed.data.distance ?? 50;
  const normalizedData={
    ...parsed.data,
    style:inferredStyle,
    hours:inferredHours,
    distance:inferredDistance
  };

  const fallback=deterministicRecommendation(normalizedData,packages);
  let recommendation={...fallback,aiUsed:false};
  let aiError='';

  try{
    recommendation=await aiRecommendation(normalizedData,packages,fallback);
  }catch(error){
    aiError=error.message;
    recommendation={...fallback,aiUsed:false};
  }

  const selected=packages.find(item=>item.code===recommendation.packageCode)
    || packages[0];
  const salesToken=crypto.randomBytes(24).toString('hex');
  const contractToken=crypto.randomBytes(24).toString('hex');
  const number=contractNumber();
  const clauses=defaultContractClauses();

  const dateHold=await dateAvailability.createHold({
    eventDate:normalizedData.date,
    customerName:normalizedData.name,
    customerEmail:normalizedData.email,
    contractToken,
    existingHoldToken:String(req.body?.holdToken||'')
  });
  normalizedData.holdToken=dateHold.hold_token;
  normalizedData.holdExpiresAt=dateHold.expires_at;

  await pool.query(
    `INSERT INTO wte_sales_sessions
     (token,status,customer_data,recommendation,package_code,ai_used,
      ai_summary,contract_token,expires_at)
     VALUES ($1,'contract_ready',$2::jsonb,$3::jsonb,$4,$5,$6,$7,NOW()+INTERVAL '30 days')`,
    [
      salesToken,
      JSON.stringify(normalizedData),
      JSON.stringify(recommendation),
      selected.code,
      Boolean(recommendation.aiUsed),
      recommendation.explanation,
      contractToken
    ]
  );

  await pool.query(
    `INSERT INTO wte_contracts
     (token,sales_token,package_code,contract_number,customer_data,
      package_snapshot,clauses)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
    [
      contractToken,salesToken,selected.code,number,
      JSON.stringify(normalizedData),
      JSON.stringify(selected),
      JSON.stringify(clauses)
    ]
  );

  const contractUrl=salesPublicUrl(contractToken);
  const recipient=normalizedData.email || normalizedData.phone;

  await notifications.queue({
    type:'contract_ready',
    recipient,
    context:{
      customerName:parsed.data.name,
      contractUrl
    },
    idempotencyKey:`contract_ready:${contractToken}`
  });

  await queueMessage({
    messageType:'contract_draft',
    recipient,
    subject:'La tua proposta Wedding Tattoo Experience',
    body:
      `Ciao ${normalizedData.name}, il pacchetto consigliato è ${selected.name}. `+
      `Puoi leggere e accettare la bozza del contratto qui: ${contractUrl}`,
    metadata:{
      salesToken,
      contractToken,
      packageCode:selected.code,
      aiUsed:Boolean(recommendation.aiUsed)
    }
  });

  res.status(201).json({
    salesToken,
    contractToken,
    contractUrl,
    draftPdf:absoluteApiUrl(contractPdfUrl(contractToken)),
    availability:{
      holdToken:dateHold.hold_token,
      status:dateHold.status,
      expiresAt:dateHold.expires_at,
      holdMinutes:dateAvailability.holdMinutes
    },
    recommendation:{
      ...recommendation,
      package:{
        code:selected.code,
        name:selected.name,
        description:selected.description,
        priceCents:selected.price_cents,
        priceLabel:selected.price_cents?euroFromCents(selected.price_cents):'Su misura',
        depositPercent:selected.deposit_percent,
        includedHours:Number(selected.included_hours),
        features:selected.features||[]
      }
    },
    // Alternative disponibili per la scelta libera del cliente.
    // Il pacchetto raccomandato resta nella card principale e qui mostriamo gli altri.
    packages:packages
      .filter(item=>item.code!==selected.code)
      .map(item=>({
        code:item.code,
        name:item.name,
        description:item.description,
        reason:item.reason,
        priceCents:item.price_cents,
        priceLabel:item.price_cents?euroFromCents(item.price_cents):'Su misura',
        depositPercent:item.deposit_percent,
        includedHours:Number(item.included_hours),
        features:item.features||[]
      })),
    ai:{
      enabled:Boolean(OPENAI_API_KEY),
      used:Boolean(recommendation.aiUsed),
      fallbackUsed:!recommendation.aiUsed,
      error:aiError
    }
  });
});


app.post('/api/public/advisor/:salesToken/select-package', publicRateLimit, async (req,res) => {
  const parsed=z.object({
    packageCode:z.string().min(1).max(40),
    contractToken:z.string().min(1).max(160)
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Selezione pacchetto non valida.'});
  }

  const salesToken=String(req.params.salesToken||'');
  const packageCode=String(parsed.data.packageCode||'').toUpperCase();
  const contractToken=String(parsed.data.contractToken||'');

  const client=await pool.connect();
  try{
    await client.query('BEGIN');

    const sessionResult=await client.query(
      `SELECT token,status,contract_token
       FROM wte_sales_sessions
       WHERE token=$1
       FOR UPDATE`,
      [salesToken]
    );

    if(!sessionResult.rowCount){
      await client.query('ROLLBACK');
      return res.status(404).json({error:'Proposta non trovata o scaduta.'});
    }

    const session=sessionResult.rows[0];
    if(session.contract_token!==contractToken){
      await client.query('ROLLBACK');
      return res.status(409).json({error:'Il contratto non corrisponde alla proposta.'});
    }

    if(session.status==='accepted' || session.status==='expired'){
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:session.status==='accepted'
          ?'La proposta è già stata accettata.'
          :'La proposta è scaduta.'
      });
    }

    const packageResult=await client.query(
      `SELECT code,name,description,reason,price_cents,deposit_percent,
              included_hours,min_guests,max_guests,max_distance_km,
              features,sort_order
       FROM wte_service_packages
       WHERE code=$1 AND active=TRUE`,
      [packageCode]
    );

    if(!packageResult.rowCount){
      await client.query('ROLLBACK');
      return res.status(404).json({error:'Pacchetto non disponibile.'});
    }

    const selected=packageResult.rows[0];

    const contractResult=await client.query(
      `SELECT token,status
       FROM wte_contracts
       WHERE token=$1 AND sales_token=$2
       FOR UPDATE`,
      [contractToken,salesToken]
    );

    if(!contractResult.rowCount){
      await client.query('ROLLBACK');
      return res.status(404).json({error:'Contratto della proposta non trovato.'});
    }

    if(contractResult.rows[0].status!=='draft'){
      await client.query('ROLLBACK');
      return res.status(409).json({error:'Il contratto non è più modificabile.'});
    }

    await client.query(
      `UPDATE wte_sales_sessions
       SET package_code=$2,status='contract_ready',updated_at=NOW()
       WHERE token=$1`,
      [salesToken,selected.code]
    );

    await client.query(
      `UPDATE wte_contracts
       SET package_code=$2,package_snapshot=$3::jsonb,updated_at=NOW()
       WHERE token=$1`,
      [contractToken,selected.code,JSON.stringify(selected)]
    );

    await client.query('COMMIT');

    return res.json({
      ok:true,
      salesToken,
      contractToken,
      contractUrl:salesPublicUrl(contractToken),
      draftPdf:absoluteApiUrl(contractPdfUrl(contractToken)),
      package:{
        code:selected.code,
        name:selected.name,
        description:selected.description,
        reason:selected.reason,
        priceCents:selected.price_cents,
        priceLabel:selected.price_cents?euroFromCents(selected.price_cents):'Su misura',
        depositPercent:selected.deposit_percent,
        includedHours:Number(selected.included_hours),
        minGuests:selected.min_guests,
        maxGuests:selected.max_guests,
        maxDistanceKm:selected.max_distance_km,
        features:selected.features||[]
      }
    });
  }catch(error){
    try{ await client.query('ROLLBACK'); }catch{}
    console.error('Select package error',error);
    return res.status(500).json({error:'Non è stato possibile selezionare il pacchetto.'});
  }finally{
    client.release();
  }
});

app.get('/api/public/contracts/:token', async (req,res) => {
  const bundle=await salesBundleByContractToken(req.params.token);
  if(!bundle)return res.status(404).json({error:'Contratto non trovato.'});

  res.json({
    contract:{
      token:bundle.token,
      contractNumber:bundle.contract_number,
      status:bundle.status,
      customer:bundle.customer_data,
      package:bundle.package_snapshot,
      clauses:bundle.clauses,
      signerName:bundle.signer_name,
      acceptedAt:bundle.accepted_at,
      recommendation:bundle.recommendation,
      aiUsed:bundle.ai_used
    },
    pdf:absoluteApiUrl(contractPdfUrl(req.params.token))
  });
});

app.get('/api/public/contracts/:token/pdf', async (req,res) => {
  const bundle=await salesBundleByContractToken(req.params.token);
  if(!bundle)return res.status(404).json({error:'Contratto non trovato.'});

  if(bundle.practice_id){
    return pdfEngine.render('contract',bundle.practice_id,{res});
  }

  return writeContractPdf(res,bundle);
});

app.post('/api/public/contracts/:token/accept', publicRateLimit, async (req,res) => {
  const parsed=z.object({
    signerName:z.string().min(2).max(180),
    signatureData:z.string().min(100),
    accepted:z.literal(true)
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({
      error:'Firma e accettazione non valide.'
    });
  }

  const bundle=await salesBundleByContractToken(req.params.token);
  if(!bundle)return res.status(404).json({error:'Contratto non trovato.'});

  if(bundle.status==='accepted'){
    const plan=await paymentPlanByPractice(bundle.practice_id);
    return res.json({
      ok:true,
      existing:true,
      practiceId:bundle.practice_id,
      paymentUrl:plan?paymentPublicUrl(plan.token):'',
      contractPdf:absoluteApiUrl(contractPdfUrl(req.params.token))
    });
  }

  const customer=bundle.customer_data||{};
  const pack=bundle.package_snapshot||{};
  const practiceId=`WTE-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  const practice={
    id:practiceId,
    createdAt:new Date().toISOString(),
    updatedAt:new Date().toISOString(),
    name:safeCustomerText(customer.name,180),
    email:safeCustomerText(customer.email,180),
    phone:safeCustomerText(customer.phone,60),
    date:safeCustomerText(customer.date,40),
    time:safeCustomerText(customer.time,20),
    location:safeCustomerText(customer.location,240),
    guests:Number(customer.guests||0),
    hours:Number(customer.hours||0),
    distance:Number(customer.distance||0),
    style:safeCustomerText(customer.style,80),
    notes:safeCustomerText(customer.notes,2000),
    package:pack.name||bundle.package_code,
    packageCode:bundle.package_code,
    priceCents:cents(pack.price_cents||0),
    status:'Contratto firmato — acconto in attesa',
    type:'Assistente pacchetto V3',
    source:'advisor-v3',
    contract:{
      token:req.params.token,
      number:bundle.contract_number,
      status:'accepted',
      acceptedAt:new Date().toISOString(),
      signerName:parsed.data.signerName,
      pdfUrl:absoluteApiUrl(contractPdfUrl(req.params.token))
    }
  };

  const client=await pool.connect();
  try{
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO wte_practices (id,data,updated_at)
       VALUES ($1,$2::jsonb,NOW())`,
      [practiceId,JSON.stringify(practice)]
    );

    await dateAvailability.attachToPractice(client,{
      eventDate:customer.date,
      holdToken:String(customer.holdToken||''),
      practiceId,
      contractToken:req.params.token
    });

    await client.query(
      `UPDATE wte_contracts
       SET practice_id=$2,status='accepted',signer_name=$3,
           signature_data=$4,accepted_at=NOW(),updated_at=NOW()
       WHERE token=$1`,
      [
        req.params.token,practiceId,parsed.data.signerName,
        parsed.data.signatureData
      ]
    );

    await client.query(
      `UPDATE wte_sales_sessions
       SET status='accepted',practice_id=$2,updated_at=NOW()
       WHERE token=$1`,
      [bundle.sales_token,practiceId]
    );

    await client.query('COMMIT');
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{
    client.release();
  }

  const plan=await createPaymentPlanFromContract(practiceId,customer,pack);
  await workflow.ensureState(practiceId,{
    actor:{type:'system',name:'Contratto automatico'},
    reason:'contract_practice_created'
  });
  await workflow.sync(practiceId,{
    actor:{type:'system',name:'Contratto automatico'},
    reason:'contract_accepted'
  });
  const paymentUrl=paymentPublicUrl(plan.token);

  await createNotification(
    'contract_accepted',
    'Nuovo contratto accettato',
    `${customer.name||'Cliente'} ha firmato il contratto ${bundle.contract_number}.`,
    practiceId,
    null
  );

  await notifications.queueForPractice(
    practiceId,
    'contract_accepted',
    {
      context:{
        customerName:customer.name||'',
        paymentUrl,
        depositCents:plan.deposit_cents,
        practiceId
      },
      idempotencyKey:`contract_accepted:${practiceId}`
    }
  );

  await queueMessage({
    practiceId,
    messageType:'contract_accepted_payment',
    recipient:customer.email||customer.phone||'',
    subject:'Contratto accettato e istruzioni acconto',
    body:
      `Ciao ${customer.name||''}, il contratto è stato accettato. `+
      `L’acconto è ${euroFromCents(plan.deposit_cents)} e scade il `+
      `${new Date(plan.deposit_due_at).toLocaleDateString('it-IT')}. `+
      `Stato e istruzioni di pagamento: ${paymentUrl}`,
    metadata:{
      contractToken:req.params.token,
      practiceId,
      paymentToken:plan.token
    }
  });

  res.status(201).json({
    ok:true,
    practiceId,
    paymentUrl,
    coupleUrl:couplePublicUrl(plan.couple_token || plan.token),
    successUrl:successPublicUrl(plan.couple_token || plan.token),
    depositCents:plan.deposit_cents,
    depositDueAt:plan.deposit_due_at,
    contractPdf:absoluteApiUrl(contractPdfUrl(req.params.token))
  });
});

app.get('/api/packages', auth, async (_req,res) => {
  res.json({packages:await activePackages()});
});

app.patch('/api/packages/:code', auth, adminOnly, async (req,res) => {
  const parsed=z.object({
    name:z.string().min(1).max(120).optional(),
    description:z.string().max(500).optional(),
    reason:z.string().max(1000).optional(),
    priceCents:z.number().int().min(0).optional(),
    depositPercent:z.number().int().min(0).max(100).optional(),
    includedHours:z.number().min(0).max(48).optional(),
    minGuests:z.number().int().min(0).max(5000).optional(),
    maxGuests:z.number().int().min(1).max(5000).optional(),
    maxDistanceKm:z.number().int().min(0).max(5000).optional(),
    features:z.array(z.string().max(180)).max(30).optional(),
    active:z.boolean().optional(),
    sortOrder:z.number().int().min(0).max(10000).optional()
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Modifica pacchetto non valida.'});
  }

  const map={
    name:'name',
    description:'description',
    reason:'reason',
    priceCents:'price_cents',
    depositPercent:'deposit_percent',
    includedHours:'included_hours',
    minGuests:'min_guests',
    maxGuests:'max_guests',
    maxDistanceKm:'max_distance_km',
    features:'features',
    active:'active',
    sortOrder:'sort_order'
  };

  const fields=[],values=[];
  for(const [key,value] of Object.entries(parsed.data)){
    values.push(key==='features'?JSON.stringify(value):value);
    fields.push(`${map[key]}=$${values.length}${key==='features'?'::jsonb':''}`);
  }
  if(!fields.length)return res.status(400).json({error:'Nessuna modifica.'});

  values.push(req.params.code.toUpperCase());
  const result=await pool.query(
    `UPDATE wte_service_packages
     SET ${fields.join(',')},updated_at=NOW()
     WHERE code=$${values.length}
     RETURNING code,name,description,reason,price_cents,deposit_percent,
               included_hours,min_guests,max_guests,max_distance_km,
               active,sort_order,features,updated_at`,
    values
  );

  if(!result.rowCount)return res.status(404).json({error:'Pacchetto non trovato.'});
  res.json({package:result.rows[0]});
});



// ============================================================
// WTE V3 FASE 4 — invii automatici, dashboard ed eccezioni
// ============================================================
function recipientChannel(recipient='') {
  return String(recipient||'').includes('@') ? 'email' : 'whatsapp';
}
function normalizedPhone(value='') { return String(value||'').replace(/[^\d+]/g,''); }
async function signedWebhook(url,payload) {
  const body=JSON.stringify(payload);
  const headers={'Content-Type':'application/json'};
  if(OUTBOUND_WEBHOOK_SECRET){
    headers['X-WTE-Signature']=crypto.createHmac('sha256',OUTBOUND_WEBHOOK_SECRET).update(body).digest('hex');
  }
  const response=await fetch(url,{method:'POST',headers,body});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||data.message||`Webhook ${response.status}`);
  return data;
}
async function deliverOutboxMessage(message) {
  const channel=message.channel==='auto'?recipientChannel(message.recipient):message.channel;
  if(channel==='email'){
    if(!OUTBOUND_EMAIL_WEBHOOK_URL)throw new Error('Canale e-mail non configurato.');
    return signedWebhook(OUTBOUND_EMAIL_WEBHOOK_URL,{channel:'email',to:message.recipient,subject:message.subject,text:message.body,practiceId:message.practice_id,messageType:message.message_type,metadata:message.metadata||{}});
  }
  if(!OUTBOUND_WHATSAPP_WEBHOOK_URL)throw new Error('Canale WhatsApp non configurato.');
  return signedWebhook(OUTBOUND_WHATSAPP_WEBHOOK_URL,{channel:'whatsapp',to:normalizedPhone(message.recipient),text:message.body,practiceId:message.practice_id,messageType:message.message_type,metadata:message.metadata||{}});
}
async function registerWorkflowException({practiceId=null,code,severity='warning',title,description='',metadata={}}) {
  await pool.query(`INSERT INTO wte_workflow_exceptions (practice_id,code,severity,title,description,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (practice_id,code,status) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,description=EXCLUDED.description,metadata=EXCLUDED.metadata,detected_at=NOW()`,[practiceId,code,severity,title,description,JSON.stringify(metadata)]);
}
async function resolveWorkflowException(practiceId,code) {
  await pool.query(`UPDATE wte_workflow_exceptions SET status='resolved',resolved_at=NOW() WHERE practice_id IS NOT DISTINCT FROM $1 AND code=$2 AND status='open'`,[practiceId,code]);
}
async function runWorkflowJob(jobName,handler) {
  const run=await pool.query(`INSERT INTO wte_workflow_runs (job_name,status) VALUES ($1,'running') RETURNING id`,[jobName]);
  const id=run.rows[0].id;
  try{
    const details=await handler();
    await pool.query(`UPDATE wte_workflow_runs SET status='success',finished_at=NOW(),details=$2::jsonb WHERE id=$1`,[id,JSON.stringify(details||{})]);
    return details;
  }catch(error){
    await pool.query(`UPDATE wte_workflow_runs SET status='failed',finished_at=NOW(),details=$2::jsonb WHERE id=$1`,[id,JSON.stringify({error:error.message})]);
    throw error;
  }
}
async function dispatchPendingMessages(limit=25) {
  const result=await pool.query(`UPDATE wte_message_outbox SET locked_at=NOW() WHERE id IN (SELECT id FROM wte_message_outbox WHERE status='pending' AND send_after<=NOW() AND (locked_at IS NULL OR locked_at<NOW()-INTERVAL '15 minutes') ORDER BY send_after ASC,id ASC LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id,practice_id,message_type,recipient,subject,body,status,send_after,metadata,channel,attempts`,[limit]);
  let sent=0,failed=0,waiting=0;
  for(const message of result.rows){
    try{
      if(!message.recipient)throw new Error('Destinatario mancante.');
      const provider=await deliverOutboxMessage(message);
      await pool.query(`UPDATE wte_message_outbox SET status='sent',sent_at=NOW(),locked_at=NULL,attempts=attempts+1,last_error='',provider_message_id=$2 WHERE id=$1`,[message.id,String(provider.id||provider.messageId||provider.reference||'')]);
      await resolveWorkflowException(message.practice_id,`message_${message.id}`); sent++;
    }catch(error){
      const configurationMissing=/non configurato/i.test(error.message);
      await pool.query(`UPDATE wte_message_outbox SET status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END,locked_at=NULL,attempts=attempts+1,last_error=$2,send_after=CASE WHEN $3::boolean THEN NOW()+INTERVAL '6 hours' ELSE NOW()+INTERVAL '15 minutes' END WHERE id=$1`,[message.id,error.message,configurationMissing]);
      await registerWorkflowException({practiceId:message.practice_id,code:`message_${message.id}`,severity:configurationMissing?'warning':'critical',title:configurationMissing?'Canale automatico da configurare':'Messaggio automatico non inviato',description:`${message.subject||message.message_type}: ${error.message}`,metadata:{outboxId:message.id,messageType:message.message_type,recipient:message.recipient}});
      configurationMissing?waiting++:failed++;
    }
  }
  return {processed:result.rowCount,sent,failed,waiting};
}
async function detectWorkflowExceptions() {
  const practices=await pool.query(`SELECT p.id,p.data,pp.deposit_status,pp.balance_status,pp.deposit_due_at,pp.balance_due_at,ge.status AS guest_status,ge.closes_at,ge.final_codes FROM wte_practices p LEFT JOIN wte_payment_plans pp ON pp.practice_id=p.id LEFT JOIN wte_guest_events ge ON ge.practice_id=p.id`);
  let detected=0,resolved=0; const now=new Date();
  for(const row of practices.rows){
    const data=row.data||{}; const eventDate=safeEventDate(data.date); const event=eventDate?new Date(`${eventDate}T12:00:00+02:00`):null; const days=event?Math.ceil((event-now)/86400000):null;
    const checks=[
      {code:'missing_event_data',active:!eventDate||!data.location||!data.time,severity:'critical',title:'Dati evento incompleti',description:'Mancano data, ora o luogo necessari alle automazioni.'},
      {code:'missing_payment_plan',active:!row.deposit_status,severity:'warning',title:'Piano pagamenti assente',description:'La pratica non ha ancora un piano acconto/saldo.'},
      {code:'deposit_overdue',active:row.deposit_status==='pending'&&row.deposit_due_at&&new Date(row.deposit_due_at)<now,severity:'critical',title:'Acconto scaduto',description:'La scadenza dell’acconto è superata e il pagamento non risulta registrato.'},
      {code:'balance_overdue',active:row.balance_status==='pending'&&row.balance_due_at&&new Date(row.balance_due_at)<now,severity:'critical',title:'Saldo scaduto',description:'Il saldo non risulta registrato entro la scadenza.'},
      {code:'guest_qr_missing',active:row.deposit_status==='paid'&&days!==null&&days>15&&!row.guest_status,severity:'critical',title:'QR invitati non creato',description:'L’acconto è pagato, ma il QR invitati non risulta disponibile.'},
      {code:'guest_pdf_missing',active:days!==null&&days<=15&&(row.guest_status!=='finalized'||!Array.isArray(row.final_codes)),severity:'critical',title:'PDF flash definitivo non pronto',description:'Mancano meno di 15 giorni e la selezione invitati non risulta finalizzata.'}
    ];
    for(const check of checks){
      if(check.active){await registerWorkflowException({practiceId:row.id,code:check.code,severity:check.severity,title:check.title,description:check.description,metadata:{daysBeforeEvent:days}});detected++;}
      else{const r=await pool.query(`UPDATE wte_workflow_exceptions SET status='resolved',resolved_at=NOW() WHERE practice_id=$1 AND code=$2 AND status='open' RETURNING id`,[row.id,check.code]);resolved+=r.rowCount;}
    }
  }
  return {practices:practices.rowCount,detected,resolved};
}
async function workflowDashboardData() {
  const exceptions=await pool.query(`SELECT e.id,e.practice_id,e.code,e.severity,e.title,e.description,e.metadata,e.detected_at,p.data FROM wte_workflow_exceptions e LEFT JOIN wte_practices p ON p.id=e.practice_id WHERE e.status='open' ORDER BY CASE e.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,e.detected_at ASC`);
  const summary=await pool.query(`SELECT COUNT(*)::int AS total_practices,COUNT(*) FILTER (WHERE COALESCE((data->'payments'->>'ready')::boolean,FALSE)=TRUE)::int AS ready_practices,COUNT(*) FILTER (WHERE data->'contract'->>'status'='accepted')::int AS signed_contracts FROM wte_practices`);
  const payments=await pool.query(`SELECT COUNT(*) FILTER (WHERE deposit_status='pending')::int AS deposits_pending,COUNT(*) FILTER (WHERE deposit_status='paid')::int AS deposits_paid,COUNT(*) FILTER (WHERE balance_status='pending')::int AS balances_pending,COUNT(*) FILTER (WHERE balance_status='paid')::int AS balances_paid FROM wte_payment_plans`);
  const messages=await pool.query(`SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,COUNT(*) FILTER (WHERE status='failed')::int AS failed,COUNT(*) FILTER (WHERE status='sent')::int AS sent FROM wte_message_outbox`);
  const upcoming=await pool.query(`SELECT id,data FROM wte_practices WHERE data->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'date')::date>=CURRENT_DATE ORDER BY (data->>'date')::date ASC LIMIT 8`);
  return {summary:summary.rows[0]||{},payments:payments.rows[0]||{},messages:messages.rows[0]||{},exceptions:exceptions.rows.map(row=>({id:row.id,practiceId:row.practice_id,code:row.code,severity:row.severity,title:row.title,description:row.description,detectedAt:row.detected_at,customer:row.data?.name||'',eventDate:row.data?.date||''})),upcoming:upcoming.rows.map(row=>({id:row.id,name:row.data?.name||'',date:row.data?.date||'',time:row.data?.time||'',location:row.data?.location||row.data?.city||'',status:row.data?.status||''})),automation:{emailConfigured:Boolean(OUTBOUND_EMAIL_WEBHOOK_URL),whatsappConfigured:Boolean(OUTBOUND_WHATSAPP_WEBHOOK_URL),webhookSigned:Boolean(OUTBOUND_WEBHOOK_SECRET)}};
}
app.get('/api/workflow-dashboard',auth,async(_req,res)=>res.json(await workflowDashboardData()));
app.post('/api/workflow/run',auth,adminOnly,async(_req,res)=>{
  const reminder=await runWorkflowJob('payment-reminders',processPaymentReminders);
  const finalization=await runWorkflowJob('guest-finalization',finalizeAllDueGuestEvents);
  const detection=await runWorkflowJob('exception-detection',detectWorkflowExceptions);
  const dispatch=await runWorkflowJob('message-dispatch',dispatchPendingMessages);
  res.json({ok:true,reminder:reminder||{},finalization:finalization||{},detection,dispatch});
});
app.post('/api/workflow-exceptions/:id/resolve',auth,async(req,res)=>{
  const result=await pool.query(`UPDATE wte_workflow_exceptions SET status='resolved',resolved_at=NOW() WHERE id=$1 RETURNING id,status,resolved_at`,[req.params.id]);
  if(!result.rowCount)return res.status(404).json({error:'Eccezione non trovata.'});
  res.json({exception:result.rows[0]});
});
app.post('/api/message-outbox/:id/retry',auth,async(req,res)=>{
  const result=await pool.query(`UPDATE wte_message_outbox SET status='pending',send_after=NOW(),locked_at=NULL,attempts=0,last_error='' WHERE id=$1 RETURNING id,status,send_after`,[req.params.id]);
  if(!result.rowCount)return res.status(404).json({error:'Messaggio non trovato.'});
  res.json({message:result.rows[0]});
});
setTimeout(()=>{runWorkflowJob('phase4-startup',async()=>{await processPaymentReminders();await finalizeAllDueGuestEvents();const detection=await detectWorkflowExceptions();const dispatch=await dispatchPendingMessages();return{detection,dispatch};}).catch(error=>console.error('Phase 4 startup error',error));},10000);
setInterval(()=>{runWorkflowJob('phase4-scheduled',async()=>{await processPaymentReminders();await finalizeAllDueGuestEvents();const detection=await detectWorkflowExceptions();const dispatch=await dispatchPendingMessages();return{detection,dispatch};}).catch(error=>console.error('Phase 4 scheduled error',error));},5*60*1000);


// ============================================================
// WTE V4 FASE B — prenotazione automatica e Area Sposi
// ============================================================

function couplePublicUrl(token) {
  return `https://www.weddingtattooexperience.it/couple.html?token=${token}`;
}

function successPublicUrl(token) {
  return `https://www.weddingtattooexperience.it/success.html?token=${token}`;
}

async function coupleBundleByToken(token) {
  const result=await pool.query(
    `SELECT pp.practice_id,pp.token,pp.couple_token,pp.currency,
            pp.total_cents,pp.deposit_cents,pp.balance_cents,
            pp.deposit_due_at,pp.balance_due_at,
            pp.deposit_payment_url,pp.balance_payment_url,
            pp.stripe_deposit_session_id,pp.stripe_balance_session_id,
            pp.deposit_status,pp.balance_status,
            pp.deposit_paid_at,pp.balance_paid_at,
            pp.deposit_receipt_url,pp.balance_receipt_url,
            pp.booking_status,
            p.data,
            ge.token AS guest_token,ge.status AS guest_status,
            ge.closes_at,ge.final_codes,ge.finalized_at,
            (
              SELECT COUNT(*)::int
              FROM wte_guest_votes gv
              WHERE gv.event_token=ge.token
            ) AS guest_votes,
            (
              SELECT COUNT(DISTINCT gv.flash_code)::int
              FROM wte_guest_votes gv
              WHERE gv.event_token=ge.token
            ) AS unique_flash
     FROM wte_payment_plans pp
     JOIN wte_practices p ON p.id=pp.practice_id
     LEFT JOIN wte_guest_events ge ON ge.practice_id=pp.practice_id
     WHERE pp.couple_token=$1 OR pp.token=$1`,
    [token]
  );
  return result.rows[0] || null;
}

async function syncBookingStatus(practiceId) {
  const plan=await paymentPlanByPractice(practiceId);
  if(!plan)return null;

  let status='deposit_pending';
  if(plan.deposit_status==='paid' && plan.balance_status==='paid'){
    status='ready';
  }else if(plan.deposit_status==='paid'){
    status='balance_pending';
  }

  const result=await pool.query(
    `UPDATE wte_payment_plans
     SET booking_status=$2,
         couple_token=COALESCE(couple_token,token),
         updated_at=NOW()
     WHERE practice_id=$1
     RETURNING practice_id,token,couple_token,booking_status`,
    [practiceId,status]
  );
  return result.rows[0] || null;
}

app.get('/api/public/couple/:token', async (req,res) => {
  let bundle=await coupleBundleByToken(req.params.token);
  if(!bundle){
    return res.status(404).json({error:'Area Sposi non trovata.'});
  }

  // Riconciliazione automatica anche entrando direttamente nell'Area Sposi:
  // serve se il cliente ha chiuso la pagina di successo o il webhook Stripe
  // è arrivato in ritardo. Non richiede un secondo pagamento.
  if(
    stripe &&
    bundle.deposit_status!=='paid' &&
    bundle.stripe_deposit_session_id
  ){
    try{
      const session=await stripe.checkout.sessions.retrieve(
        String(bundle.stripe_deposit_session_id)
      );

      if(session.payment_status==='paid'){
        let receiptUrl='';
        let providerReference=String(session.payment_intent||session.id);

        if(session.payment_intent){
          try{
            const paymentIntent=await stripe.paymentIntents.retrieve(
              String(session.payment_intent),
              {expand:['latest_charge']}
            );
            const charge=paymentIntent.latest_charge;
            if(charge && typeof charge!=='string'){
              receiptUrl=String(charge.receipt_url||'');
              providerReference=String(charge.id||paymentIntent.id);
            }
          }catch(error){
            console.error('Area Sposi Stripe receipt reconciliation error',error.message);
          }
        }

        await applyPaidPayment({
          practiceId:bundle.practice_id,
          paymentType:'deposit',
          amountCents:Number(session.amount_total||0),
          provider:'stripe',
          reference:providerReference,
          receiptUrl,
          eventKey:`stripe-session-reconcile:${session.id}`,
          occurredAt:new Date(),
          payload:{
            checkoutSessionId:session.id,
            paymentIntentId:String(session.payment_intent||''),
            reconciliation:true,
            source:'couple-area'
          }
        });

        await dateAvailability.confirmForPractice(bundle.practice_id,{
          provider:'stripe',
          checkoutSessionId:session.id,
          reconciliation:true,
          source:'couple-area'
        });

        bundle=await coupleBundleByToken(req.params.token);
      }
    }catch(error){
      // L'Area Sposi deve comunque aprirsi anche se Stripe è momentaneamente irraggiungibile.
      console.error('Area Sposi Stripe reconciliation error',error.message);
    }
  }

  await syncBookingStatus(bundle.practice_id);
  bundle=await coupleBundleByToken(req.params.token);

  const practice=bundle.data || {};
  const contract=practice.contract || {};
  const guestOpen=bundle.deposit_status==='paid' && Boolean(bundle.guest_token);
  const finalCodes=Array.isArray(bundle.final_codes)?bundle.final_codes:[];

  const steps=[
    {
      code:'contract',
      label:'Contratto',
      status:contract.status==='accepted'?'done':'pending'
    },
    {
      code:'deposit',
      label:'Acconto',
      status:bundle.deposit_status==='paid'?'done':'current'
    },
    {
      code:'guests',
      label:'Scelta invitati',
      status:
        bundle.guest_status==='finalized'
          ?'done'
          :guestOpen?'current':'locked'
    },
    {
      code:'balance',
      label:'Saldo',
      status:
        bundle.balance_status==='paid'
          ?'done'
          :bundle.deposit_status==='paid'?'current':'locked'
    },
    {
      code:'event',
      label:'Matrimonio',
      status:
        bundle.deposit_status==='paid' && bundle.balance_status==='paid'
          ?'current'
          :'locked'
    }
  ];

  res.setHeader('Cache-Control','no-store');
  res.json({
    booking:{
      status:bundle.booking_status,
      practiceId:bundle.practice_id,
      customerName:practice.name || '',
      eventDate:practice.date || '',
      eventTime:practice.time || '',
      location:practice.location || practice.city || '',
      packageName:practice.package || '',
      totalCents:bundle.total_cents,
      depositCents:bundle.deposit_cents,
      balanceCents:bundle.balance_cents,
      depositStatus:bundle.deposit_status,
      balanceStatus:bundle.balance_status,
      depositDueAt:bundle.deposit_due_at,
      balanceDueAt:bundle.balance_due_at,
      depositPaidAt:bundle.deposit_paid_at,
      balancePaidAt:bundle.balance_paid_at,
      depositPaymentUrl:bundle.deposit_payment_url,
      balancePaymentUrl:bundle.balance_payment_url,
      contractPdf:contract.pdfUrl || '',
      depositReceiptUrl:bundle.deposit_receipt_url || '',
      balanceReceiptUrl:bundle.balance_receipt_url || '',
      coupleUrl:couplePublicUrl(bundle.couple_token || bundle.token),
      successUrl:successPublicUrl(bundle.couple_token || bundle.token)
    },
    guest:{
      enabled:guestOpen,
      status:bundle.guest_status || 'locked',
      votes:Number(bundle.guest_votes||0),
      uniqueFlash:Number(bundle.unique_flash||0),
      finalCount:finalCodes.length,
      closesAt:bundle.closes_at,
      catalogUrl:guestOpen?guestPublicUrl(bundle.guest_token):'',
      qrUrl:guestOpen
        ?`https://wte-cloud-api.onrender.com/api/public/guest-event/${bundle.guest_token}/qr.svg`
        :'',
      finalPdf:
        bundle.guest_status==='finalized'
          ?`https://wte-cloud-api.onrender.com/api/guest-events/${bundle.guest_token}/pdf`
          :''
    },
    steps
  });
});

app.get('/api/public/booking-success/:token', async (req,res) => {
  const bundle=await coupleBundleByToken(req.params.token);
  if(!bundle){
    return res.status(404).json({error:'Prenotazione non trovata.'});
  }

  const practice=bundle.data || {};
  const confirmed=bundle.deposit_status==='paid';

  res.setHeader('Cache-Control','no-store');
  res.json({
    confirmed,
    booking:{
      customerName:practice.name || '',
      eventDate:practice.date || '',
      packageName:practice.package || '',
      depositCents:bundle.deposit_cents,
      depositStatus:bundle.deposit_status,
      coupleUrl:couplePublicUrl(bundle.couple_token || bundle.token)
    }
  });
});



// ============================================================
// WTE V4 PUNTO 1 — API Workflow Engine
// ============================================================

function workflowActor(req) {
  return {
    type:req.user?.role || 'staff',
    id:req.user?.id || req.user?.email || null,
    name:req.user?.name || req.user?.email || 'Staff'
  };
}

function workflowHttpError(res,error) {
  const status=Number(error.statusCode || 500);
  if(status>=500)console.error('Workflow API error',error);
  return res.status(status).json({
    error:error.message || 'Errore Workflow Engine.',
    code:error.code || 'WORKFLOW_ERROR'
  });
}

app.get('/api/workflow/config', auth, (_req,res) => {
  res.json({
    states:WORKFLOW_STATES,
    transitions:WORKFLOW_TRANSITIONS
  });
});

app.get('/api/workflow/practices', auth, async (req,res) => {
  try{
    const items=await workflow.list({
      state:String(req.query.state||''),
      limit:Number(req.query.limit||100),
      offset:Number(req.query.offset||0)
    });
    res.json({items});
  }catch(error){
    workflowHttpError(res,error);
  }
});

app.get('/api/workflow/practices/:id', auth, async (req,res) => {
  try{
    const [state,history,actions]=await Promise.all([
      workflow.getState(req.params.id),
      workflow.history(req.params.id,Number(req.query.historyLimit||100)),
      workflow.pendingActions(req.params.id,100)
    ]);
    res.json({state,history,actions});
  }catch(error){
    workflowHttpError(res,error);
  }
});

app.post('/api/workflow/practices/:id/sync', auth, async (req,res) => {
  try{
    const result=await workflow.sync(req.params.id,{
      actor:workflowActor(req),
      reason:String(req.body?.reason||'staff_sync').slice(0,240)
    });
    res.json(result);
  }catch(error){
    workflowHttpError(res,error);
  }
});

app.post('/api/workflow/practices/:id/transition', auth, async (req,res) => {
  const parsed=z.object({
    toState:z.enum(WORKFLOW_STATES),
    reason:z.string().min(1).max(240).optional().default('staff_transition'),
    payload:z.record(z.any()).optional().default({}),
    eventKey:z.string().max(240).optional().default(''),
    expectedVersion:z.number().int().min(1).optional(),
    force:z.boolean().optional().default(false)
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Transizione workflow non valida.'});
  }

  if(parsed.data.force && req.user?.role!=='admin'){
    return res.status(403).json({
      error:'Solo l’amministratore può forzare una transizione.'
    });
  }

  try{
    const result=await workflow.transition(
      req.params.id,
      parsed.data.toState,
      {
        reason:parsed.data.reason,
        payload:parsed.data.payload,
        eventKey:parsed.data.eventKey,
        expectedVersion:parsed.data.expectedVersion,
        force:parsed.data.force,
        actor:workflowActor(req)
      }
    );
    res.json(result);
  }catch(error){
    workflowHttpError(res,error);
  }
});

app.get('/api/workflow/actions', auth, async (req,res) => {
  try{
    const actions=await workflow.pendingActions(
      req.query.practiceId?String(req.query.practiceId):null,
      Number(req.query.limit||100)
    );
    res.json({actions});
  }catch(error){
    workflowHttpError(res,error);
  }
});

app.post('/api/workflow/actions/:id/status', auth, async (req,res) => {
  const parsed=z.object({
    status:z.enum(['processing','completed','failed','cancelled']),
    error:z.string().max(2000).optional().default(''),
    result:z.record(z.any()).optional().default({})
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Stato azione non valido.'});
  }

  try{
    const action=await workflow.markAction(
      Number(req.params.id),
      parsed.data.status,
      {
        error:parsed.data.error,
        result:parsed.data.result
      }
    );
    res.json({action});
  }catch(error){
    workflowHttpError(res,error);
  }
});



// ============================================================
// WTE V4 PUNTO 2 — API Scheduler Engine
// ============================================================

app.get('/api/scheduler/status', auth, (_req,res) => {
  res.json(scheduler.status());
});

app.get('/api/scheduler/runs', auth, async (req,res) => {
  try{
    const runs=await scheduler.recentRuns(Number(req.query.limit||100));
    res.json({runs});
  }catch(error){
    console.error('Scheduler runs error',error);
    res.status(500).json({error:'Impossibile leggere le esecuzioni Scheduler.'});
  }
});

app.get('/api/scheduler/runs/:id/items', auth, async (req,res) => {
  try{
    const items=await scheduler.runItems(
      Number(req.params.id),
      Number(req.query.limit||500)
    );
    res.json({items});
  }catch(error){
    console.error('Scheduler run items error',error);
    res.status(500).json({error:'Impossibile leggere i dettagli Scheduler.'});
  }
});

app.post('/api/scheduler/run', auth, adminOnly, async (req,res) => {
  try{
    const result=await scheduler.runAll({trigger:'api'});
    res.json(result);
  }catch(error){
    console.error('Scheduler run all error',error);
    res.status(500).json({error:error.message||'Esecuzione Scheduler fallita.'});
  }
});

app.post('/api/scheduler/jobs/:name/run', auth, adminOnly, async (req,res) => {
  try{
    const result=await scheduler.runJob(req.params.name,{trigger:'api'});
    res.json(result);
  }catch(error){
    const status=error.code==='UNKNOWN_JOB'?404:500;
    res.status(status).json({error:error.message||'Job Scheduler fallito.'});
  }
});



// ============================================================
// WTE V4 PUNTO 3 — API Notification Engine
// ============================================================

app.get('/api/notifications/config', auth, (_req,res) => {
  res.json(notifications.status());
});

app.get('/api/notifications', auth, async (req,res) => {
  try{
    const messages=await notifications.list({
      status:String(req.query.status||''),
      practiceId:String(req.query.practiceId||''),
      limit:Number(req.query.limit||100),
      offset:Number(req.query.offset||0)
    });
    res.json({messages});
  }catch(error){
    console.error('Notification list error',error);
    res.status(500).json({error:'Impossibile leggere le notifiche.'});
  }
});

app.post('/api/notifications/queue', auth, async (req,res) => {
  const parsed=z.object({
    practiceId:z.string().min(1).optional(),
    type:z.enum(notifications.types),
    recipient:z.string().max(240).optional().default(''),
    channel:z.enum(['auto','email','whatsapp']).optional().default('auto'),
    context:z.record(z.any()).optional().default({}),
    sendAfter:z.string().optional(),
    idempotencyKey:z.string().max(240).optional().default('')
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Notifica non valida.'});
  }

  try{
    const message=await notifications.queue({
      practiceId:parsed.data.practiceId||null,
      type:parsed.data.type,
      recipient:parsed.data.recipient,
      channel:parsed.data.channel,
      context:parsed.data.context,
      sendAfter:parsed.data.sendAfter
        ?new Date(parsed.data.sendAfter)
        :new Date(),
      idempotencyKey:parsed.data.idempotencyKey
    });
    res.status(201).json({message});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'NOTIFICATION_ERROR'
    });
  }
});

app.post('/api/notifications/dispatch', auth, adminOnly, async (req,res) => {
  try{
    const result=await notifications.dispatch(
      Number(req.body?.limit||notifications.config.batchSize)
    );
    res.json(result);
  }catch(error){
    console.error('Notification dispatch error',error);
    res.status(500).json({error:error.message||'Invio notifiche fallito.'});
  }
});

app.post('/api/notifications/:id/retry', auth, async (req,res) => {
  try{
    const message=await notifications.retry(Number(req.params.id));
    res.json({message});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'NOTIFICATION_ERROR'
    });
  }
});

app.post('/api/notifications/:id/cancel', auth, async (req,res) => {
  try{
    const message=await notifications.cancel(Number(req.params.id));
    res.json({message});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'NOTIFICATION_ERROR'
    });
  }
});



// ============================================================
// WTE V4 PUNTO 4 — API PDF Engine
// ============================================================

app.get('/api/pdf/config', auth, (_req,res) => {
  res.json({types:pdfEngine.types});
});

app.get('/api/pdf/practices/:id/documents', auth, async (req,res) => {
  try{
    const documents=await pdfEngine.listDocuments(req.params.id);
    res.json({documents});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'PDF_ENGINE_ERROR'
    });
  }
});

app.get('/api/pdf/practices/:id/:type', auth, async (req,res) => {
  try{
    await pdfEngine.render(req.params.type,req.params.id,{res});
  }catch(error){
    if(!res.headersSent){
      res.status(error.statusCode||500).json({
        error:error.message,
        code:error.code||'PDF_ENGINE_ERROR'
      });
    }
  }
});

app.post('/api/pdf/practices/:id/:type/register', auth, async (req,res) => {
  const parsed=z.object({
    storageUrl:z.string().url().optional().or(z.literal('')),
    checksum:z.string().max(240).optional().default(''),
    metadata:z.record(z.any()).optional().default({})
  }).safeParse(req.body);

  if(!parsed.success){
    return res.status(400).json({error:'Registrazione documento non valida.'});
  }

  try{
    const document=await pdfEngine.registerDocument({
      practiceId:req.params.id,
      type:req.params.type,
      storageUrl:parsed.data.storageUrl||'',
      checksum:parsed.data.checksum,
      metadata:parsed.data.metadata
    });
    res.status(201).json({document});
  }catch(error){
    res.status(error.statusCode||500).json({
      error:error.message,
      code:error.code||'PDF_ENGINE_ERROR'
    });
  }
});


app.delete('/api/practices/:id', auth, async (req,res) => {
  await pool.query('DELETE FROM wte_practices WHERE id = $1', [req.params.id]);
  res.json({ok:true});
});


app.post('/api/backups/create', auth, async (req,res) => {
  const parsed = z.object({
    practices:z.array(PracticeSchema).max(5000)
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({error:'Archivio backup non valido.'});
  }

  const result = await pool.query(
    `INSERT INTO wte_backups (data, created_at)
     VALUES ($1::jsonb, NOW())
     RETURNING id, created_at`,
    [JSON.stringify(parsed.data.practices)]
  );

  await pool.query(
    `DELETE FROM wte_backups
     WHERE id NOT IN (
       SELECT id FROM wte_backups ORDER BY created_at DESC LIMIT 30
     )`
  );

  res.status(201).json({ok:true, backup:result.rows[0]});
});

app.get('/api/backups', auth, async (_req,res) => {
  const result = await pool.query(
    'SELECT id, created_at, jsonb_array_length(data) AS count FROM wte_backups ORDER BY created_at DESC LIMIT 30'
  );
  res.json({backups:result.rows});
});

app.get('/api/backups/:id', auth, async (req,res) => {
  const result = await pool.query(
    'SELECT data, created_at FROM wte_backups WHERE id = $1',
    [req.params.id]
  );

  if (!result.rowCount) return res.status(404).json({error:'Backup non trovato.'});
  res.json(result.rows[0]);
});

app.use((error,_req,res,_next) => {
  console.error(error);
  res.status(500).json({error:'Errore interno del server.'});
});

releaseManager.registerDeployment({
  releaseName:process.env.WTE_RELEASE||'1.0.0',
  commit:process.env.RENDER_GIT_COMMIT||'',
  environment:process.env.NODE_ENV||'production',
  notes:'Avvio automatico del servizio'
}).catch(error=>console.error('Release registration error',error));

scheduler.start();

app.listen(PORT, () => {
  console.log(`WTE Cloud API attiva sulla porta ${PORT}`);
});
