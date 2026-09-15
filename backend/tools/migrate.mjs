// Migration runner. Plain SQL files, applied in filename order, each recorded
// once.
//
// No down-migrations, deliberately: reversing a schema change against live data
// is a restore-from-snapshot decision made by a person looking at the data, not
// a script run in a hurry. What this does guarantee is that a file which has
// been applied is never applied again, and that a file which fails takes
// nothing with it — each migration runs inside its own transaction, so a syntax
// error halfway down a file leaves the database exactly as it was.
//
//   node tools/migrate.mjs            apply everything outstanding
//   node tools/migrate.mjs --status   list applied and pending, change nothing

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'migrations');

const statusOnly = process.argv.includes('--status');

async function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Fall back to Secrets Manager so this works against the deployed database
  // with nothing but AWS credentials — the same path tools/db-url.mjs takes.
  if (process.env.DB_SECRET_ARN) {
    const { readSecret } = await import('../src/secrets.js');
    const secret = await readSecret(process.env.DB_SECRET_ARN);
    return secret.url;
  }

  throw new Error('Set DATABASE_URL (or DB_SECRET_ARN) before running migrations.');
}

const url = await connectionString();

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
});

await client.connect();

await client.query(`
  create table if not exists schema_migrations (
    filename   text        primary key,
    applied_at timestamptz not null default now()
  )
`);

const applied = new Set(
  (await client.query('select filename from schema_migrations')).rows.map((r) => r.filename)
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
const pending = files.filter((f) => !applied.has(f));

if (statusOnly) {
  for (const file of files) {
    console.log(`${applied.has(file) ? '  applied' : '  PENDING'}  ${file}`);
  }
  await client.end();
  process.exit(0);
}

if (!pending.length) {
  console.log('Nothing to apply — database is up to date.');
  await client.end();
  process.exit(0);
}

for (const file of pending) {
  const sql = await readFile(path.join(migrationsDir, file), 'utf8');
  process.stdout.write(`applying ${file} ... `);

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('insert into schema_migrations (filename) values ($1)', [file]);
    await client.query('COMMIT');
    console.log('ok');
  } catch (err) {
    await client.query('ROLLBACK');
    console.log('FAILED');
    console.error(`\n${file}: ${err.message}\n`);
    console.error('Nothing from this file was applied. Fix it and run again.');
    await client.end();
    process.exit(1);
  }
}

console.log(`Applied ${pending.length} migration${pending.length === 1 ? '' : 's'}.`);
await client.end();
