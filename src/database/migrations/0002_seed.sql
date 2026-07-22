-- 0002_seed.sql — development seed data.
-- Idempotent: safe to run repeatedly (ON CONFLICT / guarded inserts).

-- ---- plans ----------------------------------------------------------------
INSERT INTO plans (code, name, monthly_points, monthly_request_limit, maximum_users, price_cents, currency)
VALUES
  ('starter',      'Starter',      100000,  10000,  3,   2900, 'USD'),
  ('professional', 'Professional', 1000000, 100000, 20,  9900, 'USD'),
  ('enterprise',   'Enterprise',   10000000,1000000,200, 49900,'USD')
ON CONFLICT (code) DO NOTHING;

-- ---- plan_features --------------------------------------------------------
INSERT INTO plan_features (plan_id, feature_code, enabled, point_cost)
SELECT p.id, f.feature_code, f.enabled, f.point_cost
FROM plans p
JOIN (VALUES
  ('starter',      'ai_generation',   false, 3000),
  ('starter',      'advanced_reports',true,  500),
  ('professional', 'ai_generation',   true,  3000),
  ('professional', 'advanced_reports',true,  500),
  ('enterprise',   'ai_generation',   true,  3000),
  ('enterprise',   'advanced_reports',true,  500)
) AS f(plan_code, feature_code, enabled, point_cost) ON f.plan_code = p.code
ON CONFLICT (plan_id, feature_code) DO NOTHING;

-- ---- subscriptions --------------------------------------------------------
-- tenant-active     : Professional, active, plenty of quota
-- tenant-expired    : Starter, expired
-- tenant-exhausted  : Starter, active but points fully consumed
INSERT INTO subscriptions
  (tenant_id, plan_id, status, current_period_start, current_period_end, points_allocated, points_consumed)
SELECT 'tenant-active', p.id, 'active', now() - interval '5 days', now() + interval '25 days',
       p.monthly_points, 0
FROM plans p WHERE p.code = 'professional'
AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE tenant_id = 'tenant-active');

INSERT INTO subscriptions
  (tenant_id, plan_id, status, current_period_start, current_period_end, points_allocated, points_consumed)
SELECT 'tenant-expired', p.id, 'expired', now() - interval '40 days', now() - interval '10 days',
       p.monthly_points, p.monthly_points
FROM plans p WHERE p.code = 'starter'
AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE tenant_id = 'tenant-expired');

INSERT INTO subscriptions
  (tenant_id, plan_id, status, current_period_start, current_period_end, points_allocated, points_consumed)
SELECT 'tenant-exhausted', p.id, 'active', now() - interval '2 days', now() + interval '28 days',
       p.monthly_points, p.monthly_points
FROM plans p WHERE p.code = 'starter'
AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE tenant_id = 'tenant-exhausted');
