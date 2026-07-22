import type { FastifyInstance } from 'fastify';
import { authorizationService } from '../services/authorization.service';
import { authorizationDuration, authorizerErrors } from '../metrics/registry';
import { logger } from '../utils/logger';

interface AuthHeaders {
  authorization?: string;
  'x-original-uri'?: string;
  'x-original-method'?: string;
  'x-request-id'?: string;
}

/**
 * GET /internal/authorize — invoked by the NGINX Ingress auth-request subrequest.
 * 2xx => allow (with injected headers); 401/403 => deny. Never returns 402/429 (spec §6.1).
 */
export async function registerAuthorizeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/internal/authorize', async (req, reply) => {
    const end = authorizationDuration.startTimer();
    const h = req.headers as unknown as AuthHeaders;
    const uri = h['x-original-uri'] ?? req.url;
    const method = h['x-original-method'] ?? 'GET';
    const requestId = h['x-request-id'] ?? req.id;

    try {
      const decision = await authorizationService.authorize({
        authorization: h.authorization,
        method,
        uri,
        requestId,
      });

      for (const [k, v] of Object.entries(decision.headers)) reply.header(k, v);

      logger.info(
        {
          requestId,
          tenantId: decision.headers['X-Tenant-Id'],
          userId: decision.headers['X-User-Id'],
          operation: `${method} ${uri.split('?')[0]}`,
          plan: decision.headers['X-Plan'],
          result: decision.status,
          reason: decision.errorCode,
          remainingUnits: decision.headers['X-Quota-Remaining'],
        },
        'authorize decision',
      );

      reply.code(decision.status);
      return decision.status === 200 ? { allow: true } : { allow: false, error: decision.errorCode ?? null };
    } catch (err) {
      authorizerErrors.inc({ stage: 'authorize' });
      logger.error({ err, requestId }, 'authorize failed (fail-closed)');
      // Fail-closed: on unexpected error, deny.
      reply.code(403);
      return { allow: false, error: 'internal_error' };
    } finally {
      end();
    }
  });
}
