import { UnauthorizedError, verifyToken } from '../auth/jwt';
import { authorizationTotal, quotaReservationTotal } from '../metrics/registry';
import { operationCostService, OperationCostService } from './operation-cost.service';
import { quotaService, QuotaService } from './quota.service';
import { subscriptionService, SubscriptionService } from './subscription.service';
import type { AuthorizeDecision, Identity, Subscription, SubscriptionErrorCode } from '../types';

export interface AuthorizeInput {
  authorization: string | undefined;
  method: string;
  uri: string;
  requestId: string;
}

/** Map subscription state to a fail-closed error code, or null when it may proceed. */
function subscriptionGate(sub: Subscription | null, nowMs: number): SubscriptionErrorCode | null {
  if (!sub) return 'subscription_required';
  if (sub.currentPeriodEnd.getTime() < nowMs && sub.status !== 'expired') return 'subscription_expired';
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return null;
    case 'expired':
      return 'subscription_expired';
    case 'past_due':
      return 'payment_past_due';
    case 'suspended':
      return 'account_suspended';
    case 'cancelled':
      return 'subscription_required';
    default:
      return 'subscription_required';
  }
}

export class AuthorizationService {
  constructor(
    private readonly subs: SubscriptionService = subscriptionService,
    private readonly ops: OperationCostService = operationCostService,
    private readonly quota: QuotaService = quotaService,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async authorize(input: AuthorizeInput): Promise<AuthorizeDecision> {
    // 1. Identity (fail -> 401)
    let identity: Identity;
    try {
      identity = await verifyToken(input.authorization);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        authorizationTotal.inc({ result: 'deny_401' });
        return { status: 401, headers: {} };
      }
      throw err;
    }

    const base = { 'X-User-Id': identity.userId, 'X-Tenant-Id': identity.tenantId };

    // 2. Subscription gate (fail -> 403 + reason)
    const sub = await this.subs.getCurrent(identity.tenantId);
    const gate = subscriptionGate(sub, this.nowMs());
    if (gate || !sub) {
      const code: SubscriptionErrorCode = gate ?? 'subscription_required';
      authorizationTotal.inc({ result: 'deny_403' });
      return {
        status: 403,
        errorCode: code,
        headers: {
          ...base,
          'X-Subscription-Error': code,
          'X-Plan': sub?.plan.code ?? '',
          'X-Quota-Remaining': String(sub ? sub.pointsAllocated - sub.pointsConsumed : 0),
        },
      };
    }

    const planHeaders = { ...base, 'X-Plan': sub.plan.code };

    // 3. Operation cost — unmatched routes are free -> allow without reserving
    const match = this.ops.resolve(input.method, input.uri);
    if (!match) {
      authorizationTotal.inc({ result: 'allow' });
      return {
        status: 200,
        headers: { ...planHeaders, 'X-Quota-Remaining': String(sub.pointsAllocated - sub.pointsConsumed) },
      };
    }

    // 4. Feature entitlement
    const feature = sub.plan.features[match.feature];
    if (!feature?.enabled) {
      authorizationTotal.inc({ result: 'deny_403' });
      return {
        status: 403,
        errorCode: 'feature_not_included',
        headers: {
          ...planHeaders,
          'X-Subscription-Error': 'feature_not_included',
          'X-Quota-Remaining': String(sub.pointsAllocated - sub.pointsConsumed),
        },
      };
    }

    // 5. Atomic reservation
    const res = await this.quota.reserve(sub, match.estimatedUnits, input.requestId, match.operation);
    if (!res.ok) {
      quotaReservationTotal.inc({ result: 'rejected' });
      authorizationTotal.inc({ result: 'deny_403' });
      return {
        status: 403,
        errorCode: 'quota_exhausted',
        headers: {
          ...planHeaders,
          'X-Subscription-Error': 'quota_exhausted',
          'X-Quota-Remaining': String(Math.max(0, res.remaining)),
        },
      };
    }

    quotaReservationTotal.inc({ result: res.reason === 'idempotent' ? 'idempotent' : 'reserved' });
    authorizationTotal.inc({ result: 'allow' });
    return {
      status: 200,
      headers: {
        ...planHeaders,
        'X-Quota-Remaining': String(res.remaining),
        'X-Quota-Reservation-Id': res.reservationId,
        'X-Estimated-Units': String(match.estimatedUnits),
      },
    };
  }
}

export const authorizationService = new AuthorizationService();
