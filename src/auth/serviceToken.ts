import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Internal service-to-service authentication for /internal/quota/* (spec §14).
 * A short-lived HMAC token: `${unixSeconds}.${base64url(HMAC_SHA256(unixSeconds))}`.
 * Constant-time verification with a small clock-skew window. The shared secret comes
 * from a Kubernetes Secret (never source). mTLS is the stronger alternative in a mesh.
 */
const SKEW_SECONDS = 300;

function sign(ts: string): string {
  return createHmac('sha256', env.INTERNAL_SERVICE_TOKEN_SECRET).update(ts).digest('base64url');
}

export function mintInternalToken(nowSec: number = Math.floor(Date.now() / 1000)): string {
  const ts = String(nowSec);
  return `${ts}.${sign(ts)}`;
}

export function verifyInternalToken(
  token: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(ts);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > SKEW_SECONDS) return false;
  return true;
}
