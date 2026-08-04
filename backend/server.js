
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
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
app.use(cors({
  origin: ALLOWED_ORIGIN.split(',').map(v => v.trim()),
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

app.get('/api/health', async (_req,res) => {
  const result = await pool.query('SELECT NOW() AS now');
  res.json({ok:true, version:'2.0.0', dbTime:result.rows[0].now});
});

app.post('/api/auth/login', (req,res) => {
  const parsed = z.object({password:z.string().min(1)}).safeParse(req.body);
  if (!parsed.success || parsed.data.password !== ADMIN_PASSWORD) {
    return res.status(401).json({error:'Password Cloud non corretta.'});
  }

  const token = jwt.sign(
    {role:'admin'},
    JWT_SECRET,
    {expiresIn:'12h'}
  );

  res.json({token});
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

app.delete('/api/practices/:id', auth, async (req,res) => {
  await pool.query('DELETE FROM wte_practices WHERE id = $1', [req.params.id]);
  res.json({ok:true});
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
