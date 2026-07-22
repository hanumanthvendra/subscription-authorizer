import { Pool } from 'pg';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Shared PostgreSQL connection pool. Parameterised queries only (SQL injection safe).
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected postgres pool error');
});

export async function pingPostgres(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.warn({ err }, 'postgres ping failed');
    return false;
  }
}

export async function closePostgres(): Promise<void> {
  await pool.end();
}
