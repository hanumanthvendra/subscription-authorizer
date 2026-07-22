import { pool } from '../database/pool';
import type { Plan, PlanFeature, Subscription, SubscriptionStatus } from '../types';

interface SubRow {
  id: string;
  tenant_id: string;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date;
  points_allocated: string;
  points_consumed: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  monthly_points: string;
}

interface FeatureRow {
  feature_code: string;
  enabled: boolean;
  point_cost: number;
}

/**
 * Loads the current (non-terminal) subscription for a tenant, with plan + features.
 * Returns null when the tenant has no usable subscription.
 */
export async function findCurrentSubscription(tenantId: string): Promise<Subscription | null> {
  const { rows } = await pool.query<SubRow>(
    `SELECT s.id, s.tenant_id, s.status, s.current_period_start, s.current_period_end,
            s.points_allocated, s.points_consumed,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.monthly_points
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1
      ORDER BY (s.status IN ('active','trialing','past_due')) DESC, s.current_period_end DESC
      LIMIT 1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;

  const featRes = await pool.query<FeatureRow>(
    `SELECT feature_code, enabled, point_cost FROM plan_features WHERE plan_id = $1`,
    [row.plan_id],
  );
  const features: Record<string, PlanFeature> = {};
  for (const f of featRes.rows) {
    features[f.feature_code] = { featureCode: f.feature_code, enabled: f.enabled, pointCost: f.point_cost };
  }

  const plan: Plan = {
    id: row.plan_id,
    code: row.plan_code,
    name: row.plan_name,
    monthlyPoints: Number(row.monthly_points),
    features,
  };

  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    pointsAllocated: Number(row.points_allocated),
    pointsConsumed: Number(row.points_consumed),
    plan,
  };
}

export interface ReconcilableSubscription {
  id: string;
  tenantId: string;
  currentPeriodEnd: Date;
  pointsConsumed: number;
}

/** Subscriptions with a live billing period (have or may have a Redis quota key). */
export async function listReconcilableSubscriptions(): Promise<ReconcilableSubscription[]> {
  const { rows } = await pool.query<{ id: string; tenant_id: string; current_period_end: Date; points_consumed: string }>(
    `SELECT id, tenant_id, current_period_end, points_consumed
       FROM subscriptions
      WHERE status IN ('active','trialing','past_due')`,
  );
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    currentPeriodEnd: r.current_period_end,
    pointsConsumed: Number(r.points_consumed),
  }));
}
