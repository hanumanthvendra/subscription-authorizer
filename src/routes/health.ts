import type { FastifyInstance } from 'fastify';
import { pingPostgres } from '../database/pool';
import { pingRedis } from '../redis/client';
import { dependencyUp } from '../metrics/registry';

/**
 * Kubernetes probes.
 *  - /health/live  : process is up (no dependencies) -> liveness probe
 *  - /health/ready : PostgreSQL AND Redis reachable  -> readiness probe (gates traffic)
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_req, reply) => {
    const [postgres, redis] = await Promise.all([pingPostgres(), pingRedis()]);
    dependencyUp.set({ dependency: 'postgres' }, postgres ? 1 : 0);
    dependencyUp.set({ dependency: 'redis' }, redis ? 1 : 0);
    const ready = postgres && redis;
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks: { postgres, redis } };
  });

  // Alias used by the public Ingress bypass list.
  app.get('/health', async () => ({ status: 'ok' }));
}
