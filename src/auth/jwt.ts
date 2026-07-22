import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { env } from '../config/env';
import type { Identity } from '../types';

/** Thrown for any identity failure -> maps to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

let keySet: JWTVerifyGetKey | null = null;

/**
 * Resolve the key material once. Prefer a remote JWKS (with rotation/caching handled by
 * jose); fall back to an inline JWKS for local/dev/test. Fail-closed if neither is set.
 */
function getKeySet(): JWTVerifyGetKey {
  if (keySet) return keySet;
  if (env.JWKS_URI) {
    keySet = createRemoteJWKSet(new URL(env.JWKS_URI));
  } else if (env.JWKS_JSON) {
    keySet = createLocalJWKSet(JSON.parse(env.JWKS_JSON) as Parameters<typeof createLocalJWKSet>[0]);
  } else {
    throw new UnauthorizedError('no JWKS configured');
  }
  return keySet;
}

const algorithms = env.JWT_ALGS.split(',').map((a) => a.trim()).filter(Boolean);

function extractTenantId(p: JWTPayload): string | undefined {
  // tenant id MUST come only from the verified token (anti-spoofing).
  return (p.tenantId as string) ?? (p['tenant_id'] as string) ?? (p.tid as string);
}

/**
 * Verify a Bearer JWT: signature (via JWKS), algorithm allowlist, issuer, audience,
 * expiry (with small clock skew). Returns the identity or throws UnauthorizedError.
 */
export async function verifyToken(authorizationHeader?: string): Promise<Identity> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('missing bearer token');
  }
  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token) throw new UnauthorizedError('empty token');

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getKeySet(), {
      algorithms,
      ...(env.JWT_ISSUER ? { issuer: env.JWT_ISSUER } : {}),
      ...(env.JWT_AUDIENCE ? { audience: env.JWT_AUDIENCE } : {}),
      clockTolerance: 5, // seconds
    });
    payload = verified.payload;
  } catch (err) {
    throw new UnauthorizedError(err instanceof Error ? err.message : 'verification failed');
  }

  const userId = payload.sub;
  const tenantId = extractTenantId(payload);
  if (!userId || !tenantId) {
    throw new UnauthorizedError('token missing userId/tenantId');
  }
  return { userId, tenantId };
}
