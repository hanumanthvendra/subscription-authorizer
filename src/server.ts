import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { closePostgres } from './database/pool';
import { closeRedis } from './redis/client';
import { startWorkers, stopWorkers } from './workers';

/**
 * Process entrypoint: start HTTP server and wire graceful shutdown.
 * Migrations are run separately (see Dockerfile CMD / `npm run migrate`).
 */
async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'subscription-authorizer listening');

  startWorkers();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown started');
    try {
      stopWorkers();
      await app.close(); // stop accepting, drain in-flight
      await Promise.allSettled([closePostgres(), closeRedis()]);
      logger.info('graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
