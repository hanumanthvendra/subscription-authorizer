import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus registry. NOTE (cardinality): never label by tenantId/userId — those are
 * unbounded and live in structured logs. Labels here are bounded dimensions only.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const authorizationTotal = new Counter({
  name: 'subscription_authorization_total',
  help: 'Authorize decisions',
  labelNames: ['result'] as const, // allow | deny_401 | deny_403 | error
  registers: [registry],
});

export const authorizationDuration = new Histogram({
  name: 'subscription_authorization_duration_seconds',
  help: 'Authorize handler latency',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const authorizerErrors = new Counter({
  name: 'subscription_authorizer_errors_total',
  help: 'Unexpected authorizer errors',
  labelNames: ['stage'] as const,
  registers: [registry],
});

export const quotaReservationTotal = new Counter({
  name: 'quota_reservation_total',
  help: 'Reservation attempts',
  labelNames: ['result'] as const, // reserved | rejected | idempotent
  registers: [registry],
});

export const quotaCommitTotal = new Counter({
  name: 'quota_commit_total',
  help: 'Commit outcomes',
  labelNames: ['outcome'] as const, // committed | committed_late | not_found
  registers: [registry],
});

export const quotaReleaseTotal = new Counter({
  name: 'quota_release_total',
  help: 'Release outcomes',
  labelNames: ['outcome'] as const, // released | already_committed | not_found
  registers: [registry],
});

export const quotaReservationExpiredTotal = new Counter({
  name: 'quota_reservation_expired_total',
  help: 'Reservations released by the expiry worker',
  registers: [registry],
});

export const quotaReconciliationMismatchTotal = new Counter({
  name: 'quota_reconciliation_mismatch_total',
  help: 'Redis vs PostgreSQL quota mismatches found by reconciliation',
  labelNames: ['field'] as const, // consumed | reserved
  registers: [registry],
});

export const dependencyUp = new Gauge({
  name: 'authorizer_dependency_up',
  help: 'Dependency reachability (1 up, 0 down), refreshed by the readiness probe',
  labelNames: ['dependency'] as const, // postgres | redis
  registers: [registry],
});
