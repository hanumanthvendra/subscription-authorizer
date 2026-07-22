import { env } from '../config/env';
import { keys, redis } from '../redis/client';
import { findReservationByRequestId, insertReservation, recordSettlement } from '../repositories/quota.repository';
import { subscriptionService, SubscriptionService } from './subscription.service';
import type { Subscription } from '../types';

export interface ReserveResult {
  ok: boolean;
  reservationId: string;
  remaining: number;
  reason: string;
}

export interface CommitResult {
  outcome: 'committed' | 'committed_late' | 'not_found';
  committed: number;
  remaining: number;
  capped: boolean;
}

export interface ReleaseResult {
  outcome: 'released' | 'already_committed' | 'not_found';
  remaining: number;
}

/**
 * Real-time quota reservation. The reservation id IS the NGINX request id, so a repeated
 * auth subrequest for the same client request hits the existing Redis marker and returns
 * idempotently — never a second hold (spec D3).
 */
export class QuotaService {
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  private periodTtlSeconds(sub: Subscription): number {
    const endMs = sub.currentPeriodEnd.getTime() + env.QUOTA_PERIOD_GRACE_SECONDS * 1000;
    return Math.max(1, Math.floor((endMs - this.nowMs()) / 1000));
  }

  async reserve(sub: Subscription, estimatedUnits: number, requestId: string, operation: string): Promise<ReserveResult> {
    const reservationId = requestId; // D3: dedupe repeated subrequests via the request id
    const period = SubscriptionService.billingPeriod(sub);
    const quotaKey = keys.quota(sub.tenantId, period);
    const markerKey = keys.reservation(reservationId);

    const [ok, remaining, reason] = await redis.reserve(
      quotaKey,
      markerKey,
      estimatedUnits,
      env.RESERVATION_TTL_SECONDS,
      sub.pointsAllocated,
      this.periodTtlSeconds(sub),
      sub.pointsConsumed,
    );

    if (Number(ok) === 1 && reason !== 'idempotent') {
      // Durable record (idempotent inserts guard against races/retries).
      const expiresAt = new Date(this.nowMs() + env.RESERVATION_TTL_SECONDS * 1000);
      await insertReservation({
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        requestId,
        operation,
        estimatedUnits,
        expiresAt,
      });
    }

    return { ok: Number(ok) === 1, reservationId, remaining: Number(remaining), reason };
  }

  private async remaining(quotaKey: string): Promise<number> {
    const v = await redis.hmget(quotaKey, 'limit', 'consumed', 'reserved');
    const limit = Number(v[0] ?? 0);
    const consumed = Number(v[1] ?? 0);
    const reserved = Number(v[2] ?? 0);
    return limit - consumed - reserved;
  }

  private async quotaKeyFor(tenantId: string): Promise<string> {
    const sub = await subscriptionService.getCurrent(tenantId);
    const period = sub ? SubscriptionService.billingPeriod(sub) : '';
    return keys.quota(tenantId, period);
  }

  /** Settle actual usage: move actuals to consumed, release the unused hold. Idempotent. */
  async commit(reservationId: string, requestId: string, actualUnits: number): Promise<CommitResult> {
    const row = await findReservationByRequestId(reservationId);
    if (!row) return { outcome: 'not_found', committed: 0, remaining: 0, capped: false };

    const quotaKey = await this.quotaKeyFor(row.tenant_id);
    const marker = keys.reservation(reservationId);
    const overage = env.OVERAGE_ALLOWANCE;

    // Idempotent replay.
    if (row.status === 'committed') {
      return { outcome: 'committed', committed: Number(row.actual_units ?? 0), remaining: await this.remaining(quotaKey), capped: false };
    }

    // Late-commit (spec §9): hold already released/expired -> charge consumed directly.
    if (row.status === 'released' || row.status === 'expired') {
      const [applied, rem, capped] = await redis.consume(quotaKey, actualUnits, overage);
      await recordSettlement({
        row, newStatus: 'committed', actualUnits,
        entryType: 'adjustment', ledgerUnits: Number(applied), ledgerStatus: 'committed_late',
        metadata: { late: true, requestId },
      });
      return { outcome: 'committed_late', committed: Number(applied), remaining: Number(rem), capped: Number(capped) === 1 };
    }

    // Normal path.
    const [ok, remaining, committed, reason] = await redis.commit(quotaKey, marker, actualUnits, overage, 3600);
    if (Number(ok) !== 1 && reason === 'reservation_not_found') {
      // Marker vanished (expired between authorize and commit) -> late path.
      const [applied, rem, capped] = await redis.consume(quotaKey, actualUnits, overage);
      await recordSettlement({
        row, newStatus: 'committed', actualUnits,
        entryType: 'adjustment', ledgerUnits: Number(applied), ledgerStatus: 'committed_late',
        metadata: { late: true, requestId },
      });
      return { outcome: 'committed_late', committed: Number(applied), remaining: Number(rem), capped: Number(capped) === 1 };
    }

    await recordSettlement({
      row, newStatus: 'committed', actualUnits,
      entryType: 'commit', ledgerUnits: Number(committed), ledgerStatus: 'committed',
      metadata: { reason, requestId },
    });
    return { outcome: 'committed', committed: Number(committed), remaining: Number(remaining), capped: reason === 'capped' };
  }

  /** Return an unsettled hold to the pool. Idempotent. */
  async release(reservationId: string, requestId: string, reason: string): Promise<ReleaseResult> {
    const row = await findReservationByRequestId(reservationId);
    if (!row) return { outcome: 'not_found', remaining: 0 };

    const quotaKey = await this.quotaKeyFor(row.tenant_id);
    const marker = keys.reservation(reservationId);

    if (row.status === 'committed') return { outcome: 'already_committed', remaining: await this.remaining(quotaKey) };
    if (row.status === 'released' || row.status === 'expired') {
      return { outcome: 'released', remaining: await this.remaining(quotaKey) }; // idempotent
    }

    const [, remaining] = await redis.release(quotaKey, marker, 3600);
    await recordSettlement({
      row, newStatus: 'released', actualUnits: null,
      entryType: 'release', ledgerUnits: Number(row.estimated_units), ledgerStatus: 'released',
      metadata: { reason, requestId },
    });
    return { outcome: 'released', remaining: Number(remaining) };
  }
}

export const quotaService = new QuotaService();
