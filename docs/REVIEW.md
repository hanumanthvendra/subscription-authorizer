# Review notes — what changed and why

This is a review of the original brief and a changelog of the improvements folded into
[`TECHNICAL_SPEC.md`](./TECHNICAL_SPEC.md). Grouped by severity.

## 🔴 Correctness issues fixed (would cause real bugs)

1. **Reserve on a GET auth‑subrequest + NGINX auth caching.**
   NGINX `auth_request` always issues a GET and may repeat it, and if auth responses are
   cached the reservation is skipped or double‑counted. **Fix:** reservation is idempotent
   on `X-Request-ID` (`UNIQUE(request_id)` + Redis idempotency marker) and the spec
   explicitly forbids `auth-cache-*` on the protected Ingress. (Spec D3.)

2. **Expiry‑vs‑late‑commit race (double‑charge risk).** The brief has both an expiry
   worker and a commit endpoint but never says what happens if commit arrives *after*
   expiry. **Fix:** explicit reservation state machine (§9) with defined resolution —
   commit against an expired hold applies to `consumed` directly under the cap and writes
   an `adjustment` ledger row; never re‑inflates `reserved`, never goes negative.

3. **Idempotency keys were unspecified.** **Fix:** `quota_reservations.UNIQUE(request_id)`
   and `usage_ledger.UNIQUE(request_id, entry_type)`; commit/release keyed by
   `reservationId` with terminal‑state‑wins semantics.

4. **Billing‑period key was undefined.** `quota:{tenantId}:{billingPeriod}` never said
   what `billingPeriod` is, so period rollover would corrupt counters. **Fix:** derive it
   from `current_period_end` (or an explicit `period_id`); TTL aligned to period end + grace.

## 🟠 Performance / availability gaps

5. **Postgres in the hot path.** Loading subscription+plan from Postgres on *every*
   request blows the p95<100 ms budget. **Fix:** cache resolved subscription/plan/features
   (Redis + in‑process, short TTL, invalidated on billing webhooks); hot path becomes JWT
   verify → cache → one Redis Lua call. (D2.)

6. **Fail‑open vs fail‑closed was not defined.** **Fix:** a failure‑mode matrix (§15) —
   paid ops fail‑closed, free/unmatched ops may fail‑open — plus the trade‑off of the
   authorizer being a hard dependency of the Ingress.

7. **Redis eviction/HA not addressed.** If Redis evicts quota keys or has no HA, quota
   breaks. **Fix:** dedicated Redis, `maxmemory-policy noeviction`, Sentinel/Cluster. (D7.)

## 🟡 Consistency / correctness of the model

8. **“tokens” vs “points” used interchangeably** with no conversion rule. **Fix:** glossary
   (§3) + explicit configurable token→point mapping; “never 1:1”. (§10.)

9. **Error‑code sets didn’t line up.** The API envelope lists `DAILY_LIMIT_EXCEEDED` /
   `CONCURRENT_REQUEST_LIMIT_EXCEEDED`, but there’s no schema or logic for them. **Fix:**
   full mapping table (authorizer header → client code → HTTP), and those two are marked
   **phase 2** with a note that v1 meters monthly, per tenant.

10. **Ledger immutability wasn’t enforced anywhere.** **Fix:** DB‑level append‑only
    (INSERT/SELECT‑only role, optional trigger), corrections via `adjustment`/`refund` rows,
    optional monthly partitioning.

11. **Metric cardinality.** Labelling metrics by tenant/user would explode Prometheus.
    **Fix:** explicit guidance — tenant/user in logs/exemplars, not labels.

## 🟢 Professional polish added

- Document header (owner/version/status/date), executive summary, **goals & non‑goals**,
  glossary, assumptions/risks/**open questions**.
- Sequence diagram, decision log (D1–D7 with rationale), explicit indexes/constraints.
- **Phased delivery plan with acceptance criteria** (§21) so the build is milestone‑driven.
- Config/env reference appendix; tightened NGINX, security (alg allowlist, JWKS rotation,
  S2S auth choice), and observability sections.

## ❓ Decisions to confirm before build
See §22 of the spec — the five open questions (billing‑period format, overage policy,
authorizer‑outage behaviour, per‑tenant vs per‑user pools, daily/concurrent limits in v1).
These change the schema/logic, so worth locking down first.

## Verdict
The original was already a strong, senior‑level brief — clear flow, sensible tables, good
security instincts. The gaps were the classic *distributed‑quota* traps: idempotency of a
GET‑subrequest reservation, the expiry/commit race, period‑key definition, and hot‑path
latency. With those closed and the doc restructured, this is ready to hand to an
implementer (human or AI) and build in the phased order.
