import { createHmac } from 'node:crypto';

/**
 * Resilient client the MAIN application uses to settle usage against the authorizer's
 * internal endpoints. Framework-agnostic (uses global fetch). Safe because commit/release
 * are idempotent on the server: retries can never double-charge.
 */
export interface QuotaClientOptions {
  baseUrl: string;
  /** Shared secret for the internal service token (must match the authorizer). */
  secret: string;
  timeoutMs?: number;
  maxRetries?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  now?: () => number;
}

export interface CommitInput {
  reservationId: string;
  requestId: string;
  actualUnits: number;
}
export interface ReleaseInput {
  reservationId: string;
  requestId: string;
  reason: string;
}
export interface CommitResponse {
  committedUnits: number;
  remaining: number;
  capped: boolean;
  outcome: string;
}
export interface ReleaseResponse {
  remaining: number;
  outcome: string;
}

export class QuotaClientError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'QuotaClientError';
  }
}

/** Minimal circuit breaker: opens after N consecutive failures, half-opens after cooldown. */
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private readonly threshold: number, private readonly cooldownMs: number, private readonly now: () => number) {}

  assertClosed(): void {
    if (this.openedAt !== 0 && this.now() - this.openedAt < this.cooldownMs) {
      throw new QuotaClientError('circuit_open', 0, false);
    }
  }
  success(): void {
    this.failures = 0;
    this.openedAt = 0;
  }
  failure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

export class QuotaClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly now: () => number;
  private readonly breaker: CircuitBreaker;

  constructor(opts: QuotaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.log = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
    this.breaker = new CircuitBreaker(opts.breakerThreshold ?? 5, opts.breakerCooldownMs ?? 10_000, this.now);
  }

  commit(input: CommitInput): Promise<CommitResponse> {
    return this.post<CommitResponse>('/internal/quota/commit', input, input.requestId);
  }
  release(input: ReleaseInput): Promise<ReleaseResponse> {
    return this.post<ReleaseResponse>('/internal/quota/release', input, input.requestId);
  }

  private internalToken(): string {
    const ts = Math.floor(this.now() / 1000).toString();
    const sig = createHmac('sha256', this.secret).update(ts).digest('base64url');
    return `${ts}.${sig}`;
  }

  private backoffMs(attempt: number): number {
    const base = 100 * 2 ** (attempt - 1);
    const jitter = base * 0.25 * (this.now() % 7) / 7; // deterministic-ish jitter, no Math.random needed
    return Math.min(2000, base + jitter);
  }

  private async post<T>(path: string, body: unknown, requestId: string): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      this.breaker.assertClosed();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.internalToken() },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          this.breaker.success();
          return (await res.json()) as T;
        }
        if (res.status >= 400 && res.status < 500) {
          // Definitive answer from a healthy service — never retry (spec §12).
          this.breaker.success();
          throw new QuotaClientError(`${path} -> ${res.status}`, res.status, false);
        }
        throw new QuotaClientError(`${path} -> ${res.status}`, res.status, true); // 5xx: retryable
      } catch (err) {
        clearTimeout(timer);
        const retryable = err instanceof QuotaClientError ? err.retryable : true; // network/abort => retryable
        if (!retryable) throw err;
        this.breaker.failure();
        if (attempt > this.maxRetries) {
          this.log.error({ path, requestId, attempt, err: String(err) }, 'quota settle failed after retries');
          throw err;
        }
        const wait = this.backoffMs(attempt);
        this.log.warn({ path, requestId, attempt, wait }, 'quota settle retrying');
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
}
