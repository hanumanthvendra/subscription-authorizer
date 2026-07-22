export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'suspended'
  | 'expired';

export type SubscriptionErrorCode =
  | 'subscription_required'
  | 'subscription_expired'
  | 'payment_past_due'
  | 'feature_not_included'
  | 'quota_exhausted'
  | 'account_suspended';

export interface PlanFeature {
  featureCode: string;
  enabled: boolean;
  pointCost: number;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  monthlyPoints: number;
  features: Record<string, PlanFeature>;
}

export interface Subscription {
  id: string;
  tenantId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  pointsAllocated: number;
  pointsConsumed: number;
  plan: Plan;
}

export interface Identity {
  userId: string;
  tenantId: string;
}

export interface OperationMatch {
  feature: string;
  estimatedUnits: number;
  operation: string; // e.g. "POST /api/ai/generate"
}

/** Result of the authorize decision, shaped for the HTTP layer. */
export interface AuthorizeDecision {
  status: 200 | 401 | 403;
  headers: Record<string, string>;
  errorCode?: SubscriptionErrorCode;
}
