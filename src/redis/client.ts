import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Redis client with the quota Lua scripts registered as custom commands.
 * ioredis handles EVALSHA + fallback to EVAL and NOSCRIPT reloads automatically.
 */
function loadScript(name: string): string {
  return readFileSync(join(__dirname, 'scripts', `${name}.lua`), 'utf8');
}

export interface QuotaRedis extends Redis {
  reserve(quotaKey: string, markerKey: string, est: number, resvTtl: number, seedLimit: number, periodTtl: number, seedConsumed: number): Promise<[number, number, string]>;
  commit(quotaKey: string, markerKey: string, actual: number, overage: number, keep: number): Promise<[number, number, number, string]>;
  release(quotaKey: string, markerKey: string, keep: number): Promise<[number, number, string]>;
  // named expireHold to avoid clashing with ioredis' native EXPIRE command.
  expireHold(quotaKey: string, markerKey: string): Promise<[number, number, string]>;
  consume(quotaKey: string, add: number, overage: number): Promise<[number, number, number]>;
}

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
}) as unknown as QuotaRedis;

redis.defineCommand('reserve', { numberOfKeys: 2, lua: loadScript('reserve') });
redis.defineCommand('commit', { numberOfKeys: 2, lua: loadScript('commit') });
redis.defineCommand('release', { numberOfKeys: 2, lua: loadScript('release') });
redis.defineCommand('expireHold', { numberOfKeys: 2, lua: loadScript('expire') });
redis.defineCommand('consume', { numberOfKeys: 1, lua: loadScript('consume') });

redis.on('error', (err) => logger.error({ err }, 'redis error'));

export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err) {
    logger.warn({ err }, 'redis ping failed');
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}

/** Key helpers (single source of truth for key layout). */
export const keys = {
  quota: (tenantId: string, period: string): string => `quota:${tenantId}:${period}`,
  reservation: (reservationId: string): string => `resv:${reservationId}`,
};
