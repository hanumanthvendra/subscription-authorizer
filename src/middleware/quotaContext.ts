import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { QuotaClient } from '../clients/quota.client';

/** Parsed from the headers NGINX injects after a successful authorize. */
export interface QuotaContext {
  reservationId: string | undefined;
  estimatedUnits: number | undefined;
  tenantId: string | undefined;
  userId: string | undefined;
  plan: string | undefined;
  settled: boolean;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function quotaContextFrom(req: FastifyRequest): QuotaContext {
  const est = header(req, 'x-estimated-units');
  return {
    reservationId: header(req, 'x-quota-reservation-id'),
    estimatedUnits: est ? Number(est) : undefined,
    tenantId: header(req, 'x-tenant-id'),
    userId: header(req, 'x-user-id'),
    plan: header(req, 'x-plan'),
    settled: false,
  };
}

/**
 * MAIN-APP integration. Registers:
 *   - onRequest: parse X-Quota-* headers into req.quota
 *   - onError:   auto-release the hold if the handler threw and nothing settled it
 * Handlers call settleCommit()/settleRelease() explicitly on success / known failure.
 */
export function registerQuotaMiddleware(app: FastifyInstance, client: QuotaClient): void {
  app.decorateRequest('quota', null);

  app.addHook('onRequest', async (req) => {
    (req as unknown as { quota: QuotaContext }).quota = quotaContextFrom(req);
  });

  app.addHook('onError', async (req) => {
    const q = (req as unknown as { quota?: QuotaContext }).quota;
    if (q?.reservationId && !q.settled) {
      q.settled = true;
      try {
        await client.release({ reservationId: q.reservationId, requestId: q.reservationId, reason: 'downstream_failure' });
      } catch (err) {
        app.log.error({ err }, 'auto-release failed');
      }
    }
  });
}

export async function settleCommit(req: FastifyRequest, client: QuotaClient, actualUnits: number): Promise<void> {
  const q = (req as unknown as { quota?: QuotaContext }).quota;
  if (!q?.reservationId || q.settled) return;
  q.settled = true;
  await client.commit({ reservationId: q.reservationId, requestId: q.reservationId, actualUnits });
}

export async function settleRelease(req: FastifyRequest, client: QuotaClient, reason: string): Promise<void> {
  const q = (req as unknown as { quota?: QuotaContext }).quota;
  if (!q?.reservationId || q.settled) return;
  q.settled = true;
  await client.release({ reservationId: q.reservationId, requestId: q.reservationId, reason });
}
