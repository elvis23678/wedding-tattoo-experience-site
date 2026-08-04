
import 'dotenv/config';
import fs from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.NODE_ENV === 'production'
    ? {rejectUnauthorized:false}
    : false
});

const sql = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');

try {
  await pool.query(sql);
  console.log('Database WTE inizializzato.');
} finally {
  await pool.end();
}
