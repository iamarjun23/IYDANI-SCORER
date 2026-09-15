// One connection pool per container.
//
// Sizing is the thing to understand here. A Lambda container handles exactly
// one request at a time, so a pool larger than a couple of connections buys
// nothing — while Postgres counts every idle connection against max_connections
// (about 80 on a db.t4g.micro), and a hundred warm containers each holding ten
// idle connections exhausts the database while doing no work at all. That is
// what RDS Proxy exists to fix, and it is the right answer at scale; at this
// scale, a pool of 2 that idles out quickly is the same fix for no money.

import pg from 'pg';
import { databaseUrl, config } from './config.js';

let pool = null;

export async function getPool() {
  if (pool) return pool;

  const connectionString = await databaseUrl();

  pool = new pg.Pool({
    connectionString,
    max: config.isLambda ? 2 : 10,
    idleTimeoutMillis: config.isLambda ? 30_000 : 10_000,
    connectionTimeoutMillis: 10_000,

    // rds.force_ssl refuses a non-TLS connection outright. RDS presents a cert
    // signed by the Amazon RDS CA, which is not in Node's default trust store —
    // so verification is off here, which means the connection is encrypted but
    // not authenticated. That is a real gap and the fix is to ship the RDS CA
    // bundle and set `ca:` rather than to leave it like this once the database
    // holds anything real. Local Postgres has no TLS at all, hence the branch.
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    // An idle client erroring out is normal on a database restart; it must not
    // take the process with it, which is what an unhandled 'error' event does.
    console.error('[db] idle client error', err.message);
  });

  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}

// Single row or null — the shape almost every lookup here actually wants.
export async function queryOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] ?? null;
}

// Anything that writes more than one table goes through this. The booking flow
// in particular depends on it: confirming a booking and locking the teacher's
// slot must both happen or neither must, or a paid booking can exist against a
// slot somebody else also holds.
export async function transaction(fn) {
  const p = await getPool();
  const client = await p.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}
