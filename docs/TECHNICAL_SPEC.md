# Subscription, Token & Points‑Based Access Control — Technical Specification

| | |
|---|---|
| **Component** | Subscription Authorizer (external auth service) + main‑app integration |
| **Status** | Draft for implementation |
| **Version** | 1.0 |
| **Owner** | Venkata V — Principal DevOps & Cloud Architect |
| **Last updated** | 2026-07-22 |
| **Audience** | Platform / backend engineers, SRE, security reviewers |

---

## 1. Executive summary

We are adding a **plan‑, feature‑ and quota‑aware authorization layer** in front of a
Kubernetes application. Every inbound request is evaluated by an external
**Subscription Authorizer** (invoked by the NGINX Ingress `auth-request` subrequest)
*before* it reaches the application. The authorizer validates identity, confirms the
tenant’s subscription entitles them to the requested operation, and **atomically
reserves** the estimated cost (in internal *points*) so that concurrent traffic can
never oversell a plan. The application later **commits** actual usage or **releases**
the unused reservation. All movements are written to an **immutable usage ledger** in
PostgreSQL for billing and audit.

The design optimises for three properties, in priority order:

1. **Correctness of quota** — under concurrency, a tenant can never consume more than
   their allocation (no negative balance, no double‑charging).
2. **Low hot‑path latency** — the authorizer is on the critical path of *every*
   request; target **p95 < 100 ms**, so PostgreSQL must be kept out of the common path
   via caching (see §5).
3. **Fail‑closed for paid operations** — if the authorizer cannot make a safe decision,
   paid operations are denied rather than leaked.

---

## 2. Goals & non‑goals

### Goals
- Centralised, declarative access control for subscription, feature and quota checks.
- Real‑time atomic quota accounting that is safe across many authorizer replicas.
- Reserve‑and‑settle metering suitable for variable‑cost AI/LLM operations.
- Auditable, immutable ledger as the billing source of truth.
- First‑class operability: metrics, alerts, structured logs, reconciliation.

### Non‑goals (explicitly out of scope for v1)
- Payment capture / invoicing (we consume billing‑provider webhooks only).
- Price proration, tax, dunning workflows.
- Multi‑region active/active quota (single‑region Redis authority for v1).
- Per‑user (as opposed to per‑tenant) quota pools — v1 meters at **tenant** level.
- `DAILY_LIMIT_EXCEEDED` and `CONCURRENT_REQUEST_LIMIT_EXCEEDED` enforcement — the
  error codes are reserved (§13) but enforcement is **phase 2** (see §21).

---

## 3. Terminology

| Term | Definition |
|---|---|
| **Point / unit** | The internal, plan‑denominated quota currency. All reservations, commits and ledger entries are expressed in points. `units` and `points` are used interchangeably. |
| **AI token** | A provider‑side LLM token (input/output). **Never 1:1 with a point** — converted via a configurable rate (§10). |
| **Billing period** | The subscription’s current cycle, identified by `current_period_start`/`current_period_end`. The Redis quota key is scoped to this period (§8). |
| **Reservation** | A short‑lived hold on points created at authorize time and settled by commit/release. |
| **Operation** | A `(method, uri)` pair resolved to a `feature` and an `estimatedUnits` cost via the operation‑cost service (§6.2). |
| **Fail‑closed** | On uncertainty, deny paid operations. |

---

## 4. Architecture

### 4.1 Context

```text
                 ┌───────────────────────────────────────────────┐
   Client ──▶ NGINX Ingress ──auth_request──▶ Subscription Authorizer
                    │  (GET /internal/authorize)        │
                    │                                    ├─▶ Redis  (atomic quota: reserve/commit/release)
                    │  200 → inject headers, proxy       └─▶ Postgres (plans, subs, ledger — cached in hot path)
                    │  401 → invalid identity
                    │  403 → subscription/quota problem
                    ▼
              Main Application ──▶ POST /internal/quota/commit   (settle actual usage)
                               └─▶ POST /internal/quota/release  (return unused hold)
```

### 4.2 Happy‑path sequence (paid operation)

```text
1. Client → Ingress (Bearer JWT).
2. Ingress → Authorizer GET /internal/authorize (forwards Authorization, X-Original-URI,
   X-Original-Method, X-Request-ID).
3. Authorizer: verify JWT → (userId, tenantId); resolve operation → (feature, estUnits);
   check subscription (cached) → check feature included → Redis Lua RESERVE(estUnits).
4. RESERVE ok → 200 + headers (X-User-Id, X-Tenant-Id, X-Plan, X-Quota-Remaining,
   X-Quota-Reservation-Id, X-Estimated-Units).
5. Ingress injects headers, proxies to app.
6. App processes; on success → POST /quota/commit {reservationId, requestId, actualUnits};
   on failure → POST /quota/release {reservationId, requestId, reason}.
7. Authorizer settles Redis + appends ledger entry; returns final balance.
```

If the app **never** calls commit/release (crash, client disconnect, upstream timeout),
the **reservation‑expiry worker** releases the hold after `RESERVATION_TTL` (§15).

---

## 5. Key design decisions (and rationale)

> These are the decisions a reviewer must agree with before build. They resolve the
> subtle correctness/latency issues in the original brief.

**D1 — PostgreSQL is the source of truth; Redis is the real‑time accelerator.**
Redis holds the fast, atomic `limit/consumed/reserved` counters; Postgres holds the
durable ledger and subscription totals. On divergence, Postgres wins and the
reconciliation worker repairs Redis (§15).

**D2 — Keep Postgres out of the authorize hot path.** The original brief loads the
subscription and plan from Postgres on every request; at scale this blows the p95 budget.
Cache the resolved *(subscription, plan, features)* in Redis and/or in‑process with a
short TTL (e.g. 30–60 s), invalidated on billing webhooks. The hot path then does: JWT
verify (JWKS cached) → cache lookup → one Redis Lua call.

**D3 — The auth subrequest is a GET but performs a mutation (reserve); it MUST be
idempotent and NGINX auth caching MUST be disabled.** NGINX’s `auth_request` always
issues a GET and may repeat it; if auth responses were cached, reservations would be
skipped or double‑counted. Therefore:
- Reservation is **keyed by `X-Request-ID`** with a unique constraint — a repeated
  subrequest for the same request‑id returns the *same* reservation, never a second hold.
- **Do not** set `auth-cache-key`/`auth-cache-duration` on the protected Ingress.

**D4 — Fail‑closed for paid operations, fail‑open only for unmatched (free) routes.**
If the authorizer/Redis is unavailable, paid operations return 403/deny. Unmatched
routes (no cost) may be allowed. This is a conscious availability‑vs‑revenue trade‑off;
see §15 “Failure modes”.

**D5 — Reservation lifecycle is an explicit state machine** with defined resolution for
the expiry‑vs‑late‑commit race (§9). This is the highest‑risk area for double‑charging.

**D6 — Metrics avoid per‑tenant labels** (high cardinality). Tenant/user identifiers live
in structured logs and (optionally) exemplars, not in metric label sets (§16).

**D7 — Redis must not evict quota keys.** Use a dedicated Redis (or logical DB) with
`maxmemory-policy noeviction` for quota keys, and HA (Sentinel/Cluster) since it is
authoritative for real‑time decisions. Key TTL is aligned to `current_period_end` + grace.

---

## 6. Subscription Authorizer service

Standalone **Node.js + TypeScript + Fastify** service. Strict TS, Zod‑validated I/O.

### 6.1 Endpoints

#### `GET /internal/authorize`  (called by Ingress `auth-request`)
**Reads:** `Authorization`, `X-Original-URI`, `X-Original-Method`, `X-Request-ID`.

**Logic:** verify Bearer JWT (§14) → extract `userId`, `tenantId` → load active
subscription (cached) → resolve operation `(method,uri)` → `(feature, estUnits)` →
verify feature enabled in plan → `RESERVE(estUnits)` via Redis Lua (idempotent on
`X-Request-ID`) → persist reservation row (`status=reserved`) + ledger `reservation`
entry (async‑safe, see §9) → respond.

| Outcome | Status | Response headers |
|---|---|---|
| Allowed (paid) | `200` | `X-User-Id, X-Tenant-Id, X-Plan, X-Quota-Remaining, X-Quota-Reservation-Id, X-Estimated-Units` |
| Allowed (free/unmatched) | `200` | `X-User-Id, X-Tenant-Id, X-Plan, X-Quota-Remaining` (no reservation id) |
| Invalid/missing JWT | `401` | — |
| Subscription/quota problem | `403` | `X-Subscription-Error, X-Quota-Remaining, X-Plan` |

**`X-Subscription-Error` enum:** `subscription_required`, `subscription_expired`,
`payment_past_due`, `feature_not_included`, `quota_exhausted`, `account_suspended`.

> **NGINX constraint:** `auth_request` only distinguishes `2xx` (allow) from `401/403`
> (deny). Do **not** return `402`/`429` here — map those semantics to `403` +
> `X-Subscription-Error`, and let the app translate to a rich `402/429` for the client (§13).

#### `POST /internal/quota/commit`  *(idempotent)*
```json
{ "reservationId": "string", "requestId": "string", "actualUnits": 1950 }
```
- Look up reservation; require `status=reserved` (or already `committed` → return prior
  result idempotently).
- Move `min(actual, reserved+overage)` from `reserved` → `consumed`; **release the
  remainder** of the hold.
- Support `actual > estimated` up to `OVERAGE_ALLOWANCE`; reject beyond it
  (`overage_exceeded`) and settle at the cap with an `adjustment` ledger note.
- Append immutable `commit` ledger entry; return final `{ remaining, consumed, reserved }`.

#### `POST /internal/quota/release`  *(idempotent)*
```json
{ "reservationId": "string", "requestId": "string", "reason": "downstream_failure" }
```
- Release reserved units; set `status=released`; append `release` ledger entry.
- Repeated calls return the same terminal state.

#### Health
- `GET /health/live` — process liveness (no dependencies).
- `GET /health/ready` — verifies **PostgreSQL and Redis** connectivity; used by the
  readiness probe. Returns `503` when a dependency is down (removes pod from endpoints).

### 6.2 Operation → feature mapping
Configurable, evaluated in order; **not** hard‑coded in handlers — owned by
`operation-cost.service.ts`.

```typescript
export const operationRules: OperationRule[] = [
  { method: "POST", pattern: /^\/api\/ai\/generate/, feature: "ai_generation",    estimatedUnits: 3000 },
  { method: "POST", pattern: /^\/api\/reports/,       feature: "advanced_reports", estimatedUnits: 500  },
];
```
- First match wins. **No match ⇒ free route:** allow without reserving.
- `estimatedUnits` may be a function of the request for variable‑cost ops (see AI, §10).

### 6.3 Public / bypass routes
These bypass authorization and are served by a **separate public Ingress** (§11):
`/health`, `/health/live`, `/health/ready`, `/login`, `/logout`, `/oauth/callback`,
`/billing/plans`, `/billing/upgrade`, `/billing/webhooks`.

`/billing/webhooks` is authenticated by **provider signature verification**, never user JWT.

---

## 7. PostgreSQL data model

Migrations live in `src/database/migrations/`. All timestamps `timestamptz`. Money as
`price_cents integer` + `currency char(3)`. Use `uuid` PKs (`gen_random_uuid()`).

### 7.1 Tables (fields as in brief, with constraints/indexes made explicit)

**`plans`** — `id, code (unique), name, monthly_points, monthly_request_limit,
maximum_users, price_cents, currency, active, created_at, updated_at`.

**`plan_features`** — `id, plan_id → plans, feature_code, enabled, point_cost,
created_at`. Unique `(plan_id, feature_code)`.

**`subscriptions`** — `id, tenant_id, plan_id → plans, status, current_period_start,
current_period_end, points_allocated, points_consumed, billing_customer_id,
billing_subscription_id, created_at, updated_at`.
- `status ∈ {trialing, active, past_due, cancelled, suspended, expired}`.
- **Partial unique index**: at most one non‑terminal subscription per tenant —
  `UNIQUE (tenant_id) WHERE status IN ('trialing','active','past_due')`.
- Index `(tenant_id, status)`, `(current_period_end)`.

**`quota_reservations`** — `id, tenant_id, subscription_id, request_id, operation,
estimated_units, actual_units, status, expires_at, created_at, updated_at`.
- `status ∈ {reserved, committed, released, expired}`.
- **`UNIQUE (request_id)`** — the idempotency guarantee for D3 (prevents duplicate
  reservations from repeated auth subrequests).
- Index `(status, expires_at)` for the expiry worker; `(subscription_id)`.

**`usage_ledger`** — `id, tenant_id, subscription_id, reservation_id, request_id,
operation, units, entry_type, status, metadata (jsonb), created_at`.
- `entry_type ∈ {reservation, commit, release, refund, adjustment}`.
- **Immutable / append‑only**: revoke `UPDATE`/`DELETE` from the app role; optionally a
  `BEFORE UPDATE OR DELETE` trigger that raises. Consider **monthly partitioning** by
  `created_at` for scale. Unique `(request_id, entry_type)` to make ledger writes idempotent.

### 7.2 Immutability
Enforced in the database, not just the app: the runtime DB role has `INSERT, SELECT`
only on `usage_ledger`. Corrections are new `adjustment`/`refund` rows, never edits.

---

## 8. Redis design

**Key:** `quota:{tenantId}:{billingPeriod}` where `billingPeriod` is derived from the
subscription cycle (recommended: `current_period_end` as `YYYYMMDD`, or an explicit
`period_id`). **Hash fields:** `limit`, `consumed`, `reserved`. **TTL:** set to
`current_period_end + grace`; refreshed on write. `remaining = limit - consumed - reserved`.

Seeding: on first authorize of a period (cache miss), initialise the hash from Postgres
subscription totals inside the reserve script (or a guarded initialiser) to avoid races.

### 8.1 Lua scripts (atomic; single round trip)
All scripts are `EVALSHA`‑cached and return a typed tuple.

- **`reserve.lua(key, requestId, estUnits, ttl)`** → `{ ok, remaining, reservationState }`
  1. If a reservation for `requestId` already exists (idempotency marker) → return it.
  2. Read `limit/consumed/reserved`; compute `remaining`.
  3. If `remaining < estUnits` → return `{ 0, remaining }` (rejected).
  4. Else `reserved += estUnits`, record idempotency marker with `ttl`, return `{ 1, remaining-estUnits }`.
- **`commit.lua(key, actualUnits, reservedUnits)`** → moves `min(actual, cap)` from
  `reserved`→`consumed`, releases remainder; returns new balance. Idempotent by marker.
- **`release.lua(key, reservedUnits)`** → `reserved -= reservedUnits` (floored at 0);
  returns new balance. Idempotent by marker.
- **`expire.lua(...)`** → releases holds whose markers have expired (defensive; the
  worker also drives this via Postgres). Prevents leaked `reserved`.

**Invariants guaranteed by Lua atomicity:** `reserved ≥ 0`, `consumed ≥ 0`,
`consumed + reserved ≤ limit + overage`. Because Redis executes Lua single‑threaded,
N concurrent authorizer replicas cannot oversell.

`RESERVATION_TTL` default **10 minutes**, configurable.

---

## 9. Reservation lifecycle & race handling

```text
        reserve.lua ok            commit
   ●───────────────▶ reserved ───────────▶ committed (terminal)
                        │  │
              release   │  └───────── expiry (worker/TTL) ──▶ expired (terminal)
                        ▼
                    released (terminal)
```

**Critical races and their resolution (removes double‑charge risk):**

- **Late commit after expiry** — reservation already `expired`/released in Redis. Commit
  MUST NOT re‑inflate `reserved`. Resolution: commit against an `expired` reservation
  applies `actualUnits` directly to `consumed` (guarded by `limit+overage`) and writes an
  `adjustment` ledger entry noting late settlement; if that would exceed the cap, record
  the overage per policy. Never negative, never double.
- **Duplicate commit / release** — idempotent by `reservationId`; second call returns the
  first result.
- **Commit then release (or vice‑versa)** — only the first terminal transition wins;
  the losing call is a no‑op returning current state (HTTP `409`/`200` per config).
- **Reserve retried by NGINX** — deduplicated by `UNIQUE(request_id)` + Redis idempotency
  marker (D3).

---

## 10. AI token accounting (reserve‑and‑settle)

For AI/LLM operations the cost is variable, so reserve high and settle exact:

```text
reserve  = f(estimated_input_tokens + max_output_tokens)   # converted tokens → points
commit   = f(actual_input_tokens   + actual_output_tokens) # release the difference
failure before provider consumed tokens ⇒ release the full reservation
```

- Conversion is **configurable** and provider/model‑aware:
  `points = ceil(tokens * POINTS_PER_1K_TOKENS / 1000)` with per‑model overrides, and an
  optional monetary mapping `cost_cents = f(tokens, model)`. **Never assume 1 token = 1 point.**
- The main app supplies `actualUnits` (derived from the provider’s usage response) to
  `commit`. If the provider call throws before any usage, the app calls `release`.

---

## 11. NGINX Ingress integration

Two Ingresses on the same host:

**Protected API Ingress** — annotations:
```yaml
nginx.ingress.kubernetes.io/auth-url: "http://subscription-authorizer.auth.svc.cluster.local/internal/authorize"
nginx.ingress.kubernetes.io/auth-method: "GET"
nginx.ingress.kubernetes.io/auth-response-headers: "X-User-Id,X-Tenant-Id,X-Plan,X-Quota-Remaining,X-Quota-Reservation-Id,X-Estimated-Units"
# Do NOT set auth-cache-* — reservations must run on every request (D3).
```
Also set a bounded auth timeout (via ConfigMap `auth-keepalive`/`proxy_read_timeout`) so a
slow authorizer fails fast rather than stalling the request. Confirm the controller has
`allow-snippet-annotations`/required auth features enabled.

**Public Ingress** — the bypass routes in §6.3, no `auth-url`.

Provide: TLS (cert‑manager/`tls:` block), authorizer **Service**, **Deployment**,
**ConfigMap**, **Secret** refs, **PodDisruptionBudget**, **HorizontalPodAutoscaler**,
**NetworkPolicy** (only Ingress‑controller namespace may reach `/internal/authorize`;
only app namespace may reach `/internal/quota/*`), **ServiceAccount**.

**Deployment hardening:** 3 replicas default; readiness + liveness probes; CPU/mem
requests **and** limits; `RollingUpdate` (`maxUnavailable: 0`); graceful shutdown
(drain + finish in‑flight); `securityContext` `runAsNonRoot`, `readOnlyRootFilesystem`,
dropped capabilities, `seccompProfile: RuntimeDefault`.

---

## 12. Main‑application integration

A typed client/middleware (`clients/quota.client.ts`) the app mounts:

- Reads `X-Quota-Reservation-Id, X-Estimated-Units, X-Tenant-Id, X-User-Id, X-Plan`.
- On success: `await quotaClient.commit({ reservationId, requestId, actualUnits })`.
- On failure: `await quotaClient.release({ reservationId, requestId, reason })`.
- Resilience: timeouts, **retries with exponential backoff + jitter**, idempotency keys,
  structured logging, request‑id propagation, circuit breaker. **Never retry
  non‑retryable 4xx** (e.g. `overage_exceeded`), only 5xx/timeouts.
- If commit ultimately fails after retries, the reservation will still be reconciled by
  the expiry/reconciliation workers — no silent leak.

---

## 13. Error model

The authorizer speaks the **header protocol** (401/403 + `X-Subscription-Error`); the
**application** translates to the rich client JSON and appropriate client status
(`402 Payment Required`, `429 Too Many Requests`, etc.).

**Client error envelope:**
```json
{
  "error": {
    "code": "MONTHLY_QUOTA_EXHAUSTED",
    "message": "You have used all available tokens for your current plan.",
    "action": "UPGRADE_OR_BUY_TOKENS",
    "plan": "starter",
    "remaining": 0,
    "upgradeUrl": "/billing/plans",
    "periodEndsAt": "2026-07-31T23:59:59Z"
  }
}
```

**Mapping (authorizer → client code → client status):**

| `X-Subscription-Error` | Client `code` | HTTP |
|---|---|---|
| `subscription_required` | `SUBSCRIPTION_REQUIRED` | 402 |
| `subscription_expired` | `SUBSCRIPTION_EXPIRED` | 402 |
| `payment_past_due` | `PAYMENT_PAST_DUE` | 402 |
| `feature_not_included` | `FEATURE_NOT_INCLUDED` | 403 |
| `quota_exhausted` | `MONTHLY_QUOTA_EXHAUSTED` | 429 |
| `account_suspended` | `ACCOUNT_SUSPENDED` | 403 |
| *(phase 2)* | `DAILY_LIMIT_EXCEEDED` | 429 |
| *(phase 2)* | `CONCURRENT_REQUEST_LIMIT_EXCEEDED` | 429 |

**Frontend UX** — message: *“You’ve used all available tokens for your current plan.
Upgrade your plan or purchase additional tokens to continue.”* Actions: **Upgrade Plan**,
**Buy Additional Tokens**, **View Usage** (deep‑link `upgradeUrl`).

---

## 14. Security requirements

- **JWT:** validate `iss`, `aud`, `exp` (with small clock‑skew tolerance); enforce an
  **algorithm allowlist** (e.g. `RS256` only — reject `none` and HS/RS confusion);
  **JWKS** fetch with caching and **key rotation** (honour `kid`, refresh on unknown kid).
- **Tenant anti‑spoofing:** `tenantId`/`userId` come **only** from the verified JWT —
  never from a client header. Strip inbound `X-Tenant-Id`/`X-User-Id` at the edge.
- **Internal S2S auth (choose ONE, documented):** recommended for v1 —
  **NetworkPolicy + short‑lived signed internal service token** (HMAC/JWT with a rotated
  shared secret in a K8s Secret), verified on `/internal/quota/*`. mTLS is the stronger
  alternative if a mesh is available. `/internal/*` is never exposed publicly.
- **Input validation** with **Zod** on all bodies/headers; **SQL parameterization**
  everywhere; request‑**body size limits**; **rate limiting** on the authorizer.
- **No secrets in source** — K8s Secrets / external secret store; `.env.example` only.
- **Audit logging** of every decision; **sanitised error messages** (no internals leaked).
- **Fail‑closed** for paid operations (D4).

---

## 15. Reliability

- **Connection pooling** for Postgres and Redis; bounded pool sizes.
- **Graceful shutdown**: stop accepting, drain in‑flight, close pools.
- **Retry policies + circuit breaker** around Redis/Postgres.
- **Reservation‑expiry worker**: releases `reserved` holds past `expires_at`; marks rows
  `expired`; writes ledger `release`. Runs on a leader (lease/lock) to avoid duplicate work.
- **Reconciliation worker**: periodically compares Redis `consumed`/`reserved` vs
  Postgres reservations + ledger + subscription totals; logs discrepancies
  (`quota_reconciliation_mismatch_total`) and can **repair Redis from Postgres**
  (source of truth, D1).
- **Recovery after restart**: authorizer is stateless; Redis + Postgres hold state; on
  boot, warm caches lazily.
- **Invariants**: no negative quota; no duplicate charge (idempotency keys); concurrent
  requests cannot exceed limit (Lua atomicity, §8).

**Failure modes (fail‑closed vs fail‑open):**
| Dependency down | Paid op | Free op |
|---|---|---|
| Redis unavailable | **Deny (403)** | Allow |
| Postgres unavailable (cache warm) | Allow using cached sub + Redis | Allow |
| Postgres unavailable (cache cold) | **Deny (403)** | Allow |
| Authorizer down | Ingress `auth-url` fails → request blocked (default). Consider a separate low‑risk Ingress without auth for strictly free/public routes. |

---

## 16. Observability

**Prometheus metrics** (counters/histograms):
`subscription_authorization_total`, `subscription_authorization_duration_seconds`,
`subscription_authorizer_errors_total`, `quota_reservation_total`, `quota_commit_total`,
`quota_release_total`, `quota_units_reserved_total`, `quota_units_committed_total`,
`quota_units_released_total`, `quota_reservation_expired_total`,
`quota_reconciliation_mismatch_total`.

> **Cardinality guidance:** label by `result`, `operation`, `plan`, `outcome` — **not**
> by `tenantId`/`userId` (unbounded). Put tenant/user in logs and exemplars.

**Structured JSON logs** per decision include: `requestId, reservationId, tenantId,
userId, operation, plan, estimatedUnits, actualUnits, remainingUnits, result, reason,
durationMs`.

**Alert rules (examples):** authorizer 5xx > 1%; p95 authorize latency > 100 ms; Redis
connection failures; Postgres connection failures; reconciliation mismatches > 0;
reservations older than 10 min; sudden spike in quota denials; commit/release failures.

---

## 17. Kubernetes & Helm

`kubernetes/` (raw manifests) and `helm/` (chart) both provide: protected Ingress, public
Ingress, TLS, Service, Deployment (3 replicas, probes, requests+limits, rolling update,
graceful shutdown, hardened securityContext), ConfigMap, Secret refs, PDB, HPA,
NetworkPolicy, ServiceAccount. Helm `values.yaml` parameterises image, replicas, resources,
TTLs, JWKS URL, DB/Redis endpoints, overage allowance, and operation rules.

---

## 18. Testing strategy

Use **Testcontainers** for real Postgres/Redis where appropriate.
1. Unit (services, cost mapping, JWT).  2. Postgres integration.  3. Redis integration.
4. **Lua concurrency** (property/atomicity).  5. Authorizer API.  6. Idempotency.
7. JWT validation (alg allowlist, iss/aud/exp, JWKS rotation).  8. Subscription expiry.
9. Quota exhaustion.  10. Concurrent reservation.  11. Commit/release (incl. late‑commit
race, §9).  12. Reservation expiry.

**Headline acceptance test:** fire **≥100 simultaneous** reservations against a limit and
assert **total reserved never exceeds the configured limit** and final balances reconcile
across Redis and Postgres.

---

## 19. Project structure

```text
subscription-authorizer/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   ├── routes/
│   ├── middleware/
│   ├── services/
│   │   ├── authorization.service.ts
│   │   ├── subscription.service.ts
│   │   ├── quota.service.ts
│   │   ├── operation-cost.service.ts
│   │   └── reconciliation.service.ts
│   ├── repositories/
│   ├── redis/scripts/
│   ├── database/migrations/
│   ├── clients/
│   ├── workers/
│   ├── metrics/
│   ├── types/
│   └── utils/
├── tests/
├── kubernetes/
├── helm/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 20. Local development

`docker-compose.yml` runs: **Subscription Authorizer, PostgreSQL, Redis, Prometheus**.
Seed data: **Starter / Professional / Enterprise** plans; one **active** subscription;
one **expired** subscription; one **quota‑exhausted** subscription — enough to exercise
every `X-Subscription-Error` path end‑to‑end.

---

## 21. Delivery plan (phased, with acceptance criteria)

| Phase | Scope | Done when |
|---|---|---|
| **0. Foundations** | Repo, `package.json`, strict `tsconfig`, Zod‑validated env/config, Dockerfile, docker‑compose (PG+Redis) | `docker compose up` boots; `/health/ready` green |
| **1. Data + Redis core** | Migrations; seed data; Lua reserve/commit/release/expire | Concurrency test: 100 reservations never exceed limit |
| **2. Authorizer API** | JWT verify + JWKS; operation‑cost; `/internal/authorize`; header protocol | Auth returns correct 200/401/403 + headers for every seed subscription |
| **3. Settlement** | `commit`/`release` (idempotent) + ledger; late‑commit race handling | Idempotency + race tests green; ledger immutable |
| **4. App integration** | Quota client/middleware with resilience | Commit/release resilient under injected 5xx/timeout |
| **5. Workers** | Expiry + reconciliation (leader‑elected) | Abandoned holds released; mismatches detected & repaired |
| **6. K8s/Helm** | Manifests + chart, NetworkPolicy, HPA/PDB, hardened pod | Deploys to a cluster; Ingress auth end‑to‑end |
| **7. Observability** | Metrics, alerts, structured logs | Dashboards + alerts fire in tests |
| **8. (Optional) Phase‑2 limits** | Daily + concurrent‑request limits | New error codes enforced |

---

## 22. Assumptions, risks & open questions

**Assumptions:** single‑region Redis authority; per‑tenant (not per‑user) pools;
billing provider emits subscription lifecycle webhooks; identity issuer exposes JWKS.

**Risks:** (a) Redis is on the critical path — needs HA + `noeviction`; (b) auth‑subrequest
mutation semantics (mitigated by D3 idempotency); (c) clock skew across nodes for expiry;
(d) metric cardinality if tenant labels are added by mistake.

**Open questions for product/eng to confirm:**
1. Billing period key format — `current_period_end (YYYYMMDD)` vs an explicit `period_id`?
2. Overage policy — hard cap, or allow + bill overage as `adjustment`? What is
   `OVERAGE_ALLOWANCE`?
3. On authorizer outage, is blocking *all* protected traffic acceptable, or do we carve
   out a fail‑open lane for read‑only free routes?
4. Are points pooled per tenant, or must we also enforce per‑user sub‑limits in v1?
5. Do we need daily/concurrent limits in v1 (phase‑2 here) or is monthly sufficient?

---

## Appendix A — Implementation‑generation rules

Generate incrementally, in runnable stages (do **not** dump the whole project at once),
in this order: (1) architecture & decisions → (2) directory structure → (3) `package.json`
+ `tsconfig` + env validation → (4) migrations → (5) Lua scripts → (6) repositories &
services → (7) JWT validation → (8) routes & middleware → (9) commit/release/reconciliation
→ (10) tests → (11) Dockerfile & compose → (12) K8s manifests → (13) Helm chart →
(14) metrics & alerts → (15) README.

For every file: print the **relative path**, then the **complete content** (no omitted
imports, no “implement later” placeholders). Keep code **strongly typed** under
`strict: true`, include error handling, explain security‑sensitive choices inline, and
ensure the stack runs locally via Docker Compose.

## Appendix B — Configuration reference (env)

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `8080` |
| `DATABASE_URL` | Postgres DSN | — |
| `REDIS_URL` | Redis DSN (dedicated/`noeviction`) | — |
| `JWKS_URI` | Identity provider JWKS endpoint | — |
| `JWT_ISSUER` / `JWT_AUDIENCE` | Token validation | — |
| `JWT_ALGS` | Allowed algs | `RS256` |
| `RESERVATION_TTL_SECONDS` | Hold lifetime | `600` |
| `OVERAGE_ALLOWANCE` | Max units above estimate on commit | `0` |
| `POINTS_PER_1K_TOKENS` | AI token→point base rate | config |
| `INTERNAL_SERVICE_TOKEN_SECRET` | S2S auth for `/internal/quota/*` | — |
| `SUBSCRIPTION_CACHE_TTL_SECONDS` | Hot‑path sub cache | `45` |
| `RATE_LIMIT_*` | Authorizer rate limiting | config |
```
