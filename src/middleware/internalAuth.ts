import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyInternalToken } from '../auth/serviceToken';

/**
 * Fastify preHandler that gates internal endpoints. Combined with NetworkPolicy
 * (only the app namespace may reach /internal/quota/*), this is defence in depth.
 */
export async function requireInternalAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.headers['x-internal-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!verifyInternalToken(token)) {
    reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
  }
}
