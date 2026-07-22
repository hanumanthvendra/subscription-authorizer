import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePostgres } from './pool';
import { logger } from '../utils/logger';

/**
 * Minimal, dependency-free forward-only migration runner.
 * Applies every *.sql file in ./migrations (lexical order) exactly once,
 * each inside its own transaction, tracked in schema_migrations.
 */
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureTracker(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

// Serialize concurrent migrators (e.g. a migration Job racing a leftover runner) with a
// Postgres session advisory lock. Whoever loses the lock waits, then finds nothing to do.
const MIGRATION_LOCK = 728_913;

export async function migrate(): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await applyMigrations();
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    lock.release();
  }
}

async function applyMigrations(): Promise<void> {
  await ensureTracker();
  const done = await appliedSet();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (done.has(file)) {
      logger.debug({ file }, 'migration already applied');
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, file }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Retry wrapper so a DB that is briefly unavailable at boot (init/restart) doesn't crash us. */
async function withRetry<T>(fn: () => Promise<T>, tries = 15, delayMs = 1000): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw err;
      logger.warn({ attempt, delayMs }, 'database not ready, retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Allow running as a standalone entrypoint: `node dist/database/migrate.js`
if (require.main === module) {
  withRetry(migrate)
    .then(() => closePostgres())
    .then(() => {
      logger.info('migrations complete');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'migration run failed');
      process.exit(1);
    });
}
