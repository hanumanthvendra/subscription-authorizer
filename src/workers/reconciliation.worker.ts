import { env } from '../config/env';
import { logger } from '../utils/logger';
import { keys, redis } from '../redis/client';
import { sumCommittedUnits, sumReservedUnits } from '../repositories/quota.repository';
import { listReconcilableSubscriptions } from '../repositories/subscription.repository';
import { SubscriptionService } from '../services/subscription.service';
import { quotaReconciliationMismatchTotal } from '../metrics/registry';

/**
 * Compares Redis real-time counters against PostgreSQL (the source of truth) and logs
 * (optionally repairs) drift. Expected values:
 *   consumed = subscription.points_consumed + Σ ledger(commit, adjustment)
 *   reserved = Σ reservations still in 'reserved' state
 */
export async function reconcileOnce(): Promise<number> {
  const subs = await listReconcilableSubscriptions();
  let mismatches = 0;

  for (const s of subs) {
    const period = SubscriptionService.billingPeriodFromDate(s.currentPeriodEnd);
    const quotaKey = keys.quota(s.tenantId, period);
    if ((await redis.exists(quotaKey)) === 0) continue; // not seeded yet

    const [committed, reservedExpected] = await Promise.all([
      sumCommittedUnits(s.id),
      sumReservedUnits(s.id),
    ]);
    const consumedExpected = s.pointsConsumed + committed;

    const v = await redis.hmget(quotaKey, 'consumed', 'reserved');
    const consumedActual = Number(v[0] ?? 0);
    const reservedActual = Number(v[1] ?? 0);

    if (consumedActual !== consumedExpected) {
      mismatches += 1;
      quotaReconciliationMismatchTotal.inc({ field: 'consumed' });
      logger.warn({ tenantId: s.tenantId, field: 'consumed', consumedActual, consumedExpected }, 'reconciliation mismatch');
      if (env.RECONCILE_REPAIR === 'true') await redis.hset(quotaKey, 'consumed', consumedExpected);
    }
    if (reservedActual !== reservedExpected) {
      mismatches += 1;
      quotaReconciliationMismatchTotal.inc({ field: 'reserved' });
      logger.warn({ tenantId: s.tenantId, field: 'reserved', reservedActual, reservedExpected }, 'reconciliation mismatch');
      if (env.RECONCILE_REPAIR === 'true') await redis.hset(quotaKey, 'reserved', reservedExpected);
    }
  }

  if (mismatches > 0) logger.warn({ mismatches, repaired: env.RECONCILE_REPAIR === 'true' }, 'reconciliation found drift');
  return mismatches;
}
