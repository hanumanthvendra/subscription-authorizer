import { env } from '../config/env';
import { logger } from '../utils/logger';
import { keys, redis } from '../redis/client';
import { findExpiredReservations, recordSettlement } from '../repositories/quota.repository';
import { subscriptionService, SubscriptionService } from '../services/subscription.service';
import { quotaReservationExpiredTotal } from '../metrics/registry';

/**
 * Releases holds whose reservation expired before the app committed/released (client
 * disconnect, crash, upstream timeout). Postgres is the source of truth for expiry;
 * Redis `reserved` is decremented via expire.lua so it can never leak.
 */
export async function sweepExpiredReservations(): Promise<number> {
  const rows = await findExpiredReservations(env.EXPIRY_BATCH_SIZE);
  let released = 0;

  for (const row of rows) {
    try {
      const sub = await subscriptionService.getCurrent(row.tenant_id);
      const period = sub ? SubscriptionService.billingPeriod(sub) : '';
      const quotaKey = keys.quota(row.tenant_id, period);
      const marker = keys.reservation(row.request_id);

      await redis.expireHold(quotaKey, marker);
      await recordSettlement({
        row,
        newStatus: 'expired',
        actualUnits: null,
        entryType: 'release',
        ledgerUnits: Number(row.estimated_units),
        ledgerStatus: 'expired',
        metadata: { expired: true },
      });
      quotaReservationExpiredTotal.inc();
      released += 1;
    } catch (err) {
      logger.error({ err, requestId: row.request_id }, 'expiry release failed');
    }
  }

  if (released > 0) logger.info({ released }, 'expiry sweep released abandoned holds');
  return released;
}
