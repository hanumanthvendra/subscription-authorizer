import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Headline invariant test (spec §18):
 * fire >= 100 simultaneous reservations against a fixed limit and prove that the total
 * reserved quota NEVER exceeds the limit — i.e. the Lua reserve script cannot oversell,
 * regardless of concurrency.
 *
 * Requires a Redis reachable at REDIS_URL (default redis://localhost:6379).
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

interface ReserveRedis extends Redis {
  reserve(q: string, m: string, est: number, rttl: number, seed: number, pttl: number, seedConsumed: number): Promise<[number, number, string]>;
}

const redis = new Redis(REDIS_URL) as ReserveRedis;

beforeAll(() => {
  const lua = readFileSync(join(__dirname, '..', 'src', 'redis', 'scripts', 'reserve.lua'), 'utf8');
  redis.defineCommand('reserve', { numberOfKeys: 2, lua });
});

afterAll(async () => {
  await redis.quit();
});

describe('reserve.lua concurrency', () => {
  it('never reserves more than the configured limit under 100 concurrent requests', async () => {
    const LIMIT = 1000;
    const EST = 30; // expected max successes = floor(1000/30) = 33
    const N = 100;
    const period = `test-${Date.now()}`;
    const quotaKey = `quota:tenant-x:${period}`;

    await redis.del(quotaKey);

    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        redis.reserve(quotaKey, `resv:test-${period}-${i}`, EST, 600, LIMIT, 3600, 0),
      ),
    );

    const successes = results.filter((r) => Number(r[0]) === 1).length;
    const reserved = Number(await redis.hget(quotaKey, 'reserved'));

    expect(successes).toBe(Math.floor(LIMIT / EST)); // exactly 33 fit
    expect(reserved).toBe(successes * EST);
    expect(reserved).toBeLessThanOrEqual(LIMIT); // the invariant: never oversold

    await redis.del(quotaKey);
  });
});
