import { env } from '../config/env';
import { findCurrentSubscription } from '../repositories/subscription.repository';
import type { Subscription } from '../types';

interface CacheEntry {
  value: Subscription | null;
  expiresAtMs: number;
}

/**
 * Keeps PostgreSQL out of the authorize hot path (spec D2): resolved subscriptions are
 * cached in-process for a short TTL. Invalidated explicitly on billing webhooks (phase 2+).
 */
export class SubscriptionService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = env.SUBSCRIPTION_CACHE_TTL_SECONDS * 1000;

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async getCurrent(tenantId: string): Promise<Subscription | null> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAtMs > this.nowMs()) return hit.value;

    const value = await findCurrentSubscription(tenantId);
    this.cache.set(tenantId, { value, expiresAtMs: this.nowMs() + this.ttlMs });
    return value;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Billing period identifier used in the Redis quota key: period end as YYYYMMDD (UTC). */
  static billingPeriodFromDate(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  static billingPeriod(sub: Subscription): string {
    return SubscriptionService.billingPeriodFromDate(sub.currentPeriodEnd);
  }
}

export const subscriptionService = new SubscriptionService();
