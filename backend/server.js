
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import pg from 'pg';
import { z } from 'zod';

const { Pool } = pg;

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.weddingtattooexperience.it';

if (!JWT_SECRET || !ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('Mancano JWT_SECRET, ADMIN_PASSWORD o DATABASE_URL.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized:false }
    : false
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
  methods:['GET','POST','DELETE','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization','X-WTE-Device']
}));
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

app.get('/api/health', async (_req,res) => {
  const result = await pool.query('SELECT NOW() AS now');
  res.json({ok:true, version:'9.0.0', dbTime:result.rows[0].now});
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

  await pool.query(
    `INSERT INTO wte_practices (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [practice.id, JSON.stringify(practice)]
  );

  await createNotification(
    'new_practice',
    'Nuova richiesta Wedding',
    `${practice.name || 'Un cliente'} ha inviato una richiesta per il ${practice.date || 'data da definire'}.`,
    practice.id,
    null
  );

  res.status(201).json({ok:true, id:practice.id});
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
      image:`${req.protocol}://${req.get('host')}/api/public/flash-catalog/${item.id}/image`
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
    sortOrder:z.number().int().min(0).max(100000).optional()
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

  Object.entries(parsed.data).forEach(([key,value]) => {
    values.push(value);
    fields.push(`${map[key]}=$${values.length}`);
  });

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

    await logActivity(req,'Flash modificato',null,{id:req.params.id,changes:parsed.data});
    res.json({item:result.rows[0]});
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({error:'Codice flash già esistente.'});
    throw error;
  }
});

app.delete('/api/flash-catalog/:id', auth, adminOnly, async (req,res) => {
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
  return row?.payload && typeof row.payload === 'object' ? row.payload : {};
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
    'SELECT id,payload,created_at,updated_at FROM wte_practices WHERE id=$1',
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

app.listen(PORT, () => {
  console.log(`WTE Cloud API attiva sulla porta ${PORT}`);
});
