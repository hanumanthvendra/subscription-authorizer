import { redis } from '../redis/client';

/**
 * Best-effort leader election via a Redis lock so only one replica runs a given worker
 * at a time. Not a consensus algorithm — good enough for idempotent sweeps, and every
 * operation the workers perform is itself idempotent.
 */
export class Leader {
  private readonly token = `${process.pid}-${process.hrtime.bigint().toString(36)}`;

  constructor(private readonly key: string, private readonly ttlMs: number) {}

  async isLeader(): Promise<boolean> {
    const acquired = await redis.set(this.key, this.token, 'PX', this.ttlMs, 'NX');
    if (acquired === 'OK') return true;
    const current = await redis.get(this.key);
    if (current === this.token) {
      await redis.pexpire(this.key, this.ttlMs); // renew our own hold
      return true;
    }
    return false;
  }
}
