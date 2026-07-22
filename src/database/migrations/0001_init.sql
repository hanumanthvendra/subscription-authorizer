-- 0001_init.sql — core schema for subscription/points access control.
-- All timestamps are timestamptz. Money is integer cents + ISO currency.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- plans
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  monthly_points        bigint NOT NULL CHECK (monthly_points >= 0),
  monthly_request_limit bigint NOT NULL DEFAULT 0 CHECK (monthly_request_limit >= 0),
  maximum_users         integer NOT NULL DEFAULT 1 CHECK (maximum_users >= 1),
  price_cents           integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency              char(3) NOT NULL DEFAULT 'USD',
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- plan_features
-- ---------------------------------------------------------------------------
CREATE TABLE plan_features (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_code  text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  point_cost    integer NOT NULL DEFAULT 0 CHECK (point_cost >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, feature_code)
);

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                text NOT NULL,
  plan_id                  uuid NOT NULL REFERENCES plans(id),
  status                   text NOT NULL
                            CHECK (status IN ('trialing','active','past_due','cancelled','suspended','expired')),
  current_period_start     timestamptz NOT NULL,
  current_period_end       timestamptz NOT NULL,
  points_allocated         bigint NOT NULL CHECK (points_allocated >= 0),
  points_consumed          bigint NOT NULL DEFAULT 0 CHECK (points_consumed >= 0),
  billing_customer_id      text,
  billing_subscription_id  text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);

-- At most one non-terminal subscription per tenant.
CREATE UNIQUE INDEX subscriptions_active_per_tenant
  ON subscriptions (tenant_id)
  WHERE status IN ('trialing','active','past_due');

CREATE INDEX subscriptions_tenant_status ON subscriptions (tenant_id, status);
CREATE INDEX subscriptions_period_end    ON subscriptions (current_period_end);

-- ---------------------------------------------------------------------------
-- quota_reservations
-- ---------------------------------------------------------------------------
CREATE TABLE quota_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  request_id      text NOT NULL,
  operation       text NOT NULL,
  estimated_units bigint NOT NULL CHECK (estimated_units >= 0),
  actual_units    bigint,
  status          text NOT NULL DEFAULT 'reserved'
                   CHECK (status IN ('reserved','committed','released','expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: a given request can only ever create one reservation.
CREATE UNIQUE INDEX quota_reservations_request_id ON quota_reservations (request_id);
CREATE INDEX quota_reservations_status_expiry ON quota_reservations (status, expires_at);
CREATE INDEX quota_reservations_subscription ON quota_reservations (subscription_id);

-- ---------------------------------------------------------------------------
-- usage_ledger  (append-only / immutable)
-- ---------------------------------------------------------------------------
CREATE TABLE usage_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  reservation_id  uuid REFERENCES quota_reservations(id),
  request_id      text NOT NULL,
  operation       text NOT NULL,
  units           bigint NOT NULL,
  entry_type      text NOT NULL
                   CHECK (entry_type IN ('reservation','commit','release','refund','adjustment')),
  status          text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Ledger writes are idempotent per (request_id, entry_type).
CREATE UNIQUE INDEX usage_ledger_request_entry ON usage_ledger (request_id, entry_type);
CREATE INDEX usage_ledger_tenant_created ON usage_ledger (tenant_id, created_at);
CREATE INDEX usage_ledger_subscription   ON usage_ledger (subscription_id);

-- Enforce immutability at the database level: no UPDATE / DELETE, ever.
CREATE OR REPLACE FUNCTION usage_ledger_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_ledger is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER usage_ledger_no_mutation
  BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION usage_ledger_immutable();
