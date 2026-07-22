import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../middleware/internalAuth';
import { quotaService } from '../services/quota.service';
import { quotaCommitTotal, quotaReleaseTotal } from '../metrics/registry';
import { logger } from '../utils/logger';

const commitSchema = z.object({
  reservationId: z.string().min(1),
  requestId: z.string().min(1),
  actualUnits: z.number().int().min(0),
});

const releaseSchema = z.object({
  reservationId: z.string().min(1),
  requestId: z.string().min(1),
  reason: z.string().min(1).default('unspecified'),
});

/**
 * Internal settlement endpoints. Guarded by service-to-service auth (spec §14) and,
 * in the cluster, by a NetworkPolicy restricting callers to the app namespace.
 */
export async function registerQuotaRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/quota/commit', { preHandler: requireInternalAuth }, async (req, reply) => {
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', details: parsed.error.issues } };
    }
    const { reservationId, requestId, actualUnits } = parsed.data;
    const result = await quotaService.commit(reservationId, requestId, actualUnits);
    quotaCommitTotal.inc({ outcome: result.outcome });
    logger.info({ requestId, reservationId, actualUnits, ...result }, 'quota commit');

    if (result.outcome === 'not_found') {
      reply.code(404);
      return { error: { code: 'RESERVATION_NOT_FOUND' } };
    }
    reply.code(200);
    return { committedUnits: result.committed, remaining: result.remaining, capped: result.capped, outcome: result.outcome };
  });

  app.post('/internal/quota/release', { preHandler: requireInternalAuth }, async (req, reply) => {
    const parsed = releaseSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', details: parsed.error.issues } };
    }
    const { reservationId, requestId, reason } = parsed.data;
    const result = await quotaService.release(reservationId, requestId, reason);
    quotaReleaseTotal.inc({ outcome: result.outcome });
    logger.info({ requestId, reservationId, reason, ...result }, 'quota release');

    if (result.outcome === 'not_found') {
      reply.code(404);
      return { error: { code: 'RESERVATION_NOT_FOUND' } };
    }
    reply.code(200);
    return { remaining: result.remaining, outcome: result.outcome };
  });
}
