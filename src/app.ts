import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env';
import { logger } from './utils/logger';
import { registerHealthRoutes } from './routes/health';
import { registerAuthorizeRoutes } from './routes/authorize';
import { registerQuotaRoutes } from './routes/quota';
import { registry } from './metrics/registry';

/**
 * Builds the Fastify app. Kept free of I/O side effects so it is unit-testable.
 * Business routes (authorize / quota) are added in later phases.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we use our own pino instance
    bodyLimit: env.BODY_LIMIT_BYTES,
    disableRequestLogging: true,
    trustProxy: true,
  });

  app.addHook('onRequest', async (req) => {
    (req as { startedAt?: bigint }).startedAt = process.hrtime.bigint();
  });

  await registerHealthRoutes(app);
  await registerAuthorizeRoutes(app);
  await registerQuotaRoutes(app);

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled request error');
    // sanitised error to the caller
    reply.code(err.statusCode ?? 500).send({ error: { code: 'INTERNAL_ERROR' } });
  });

  return app;
}
