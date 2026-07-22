import { z } from 'zod';

/**
 * Strongly-typed, validated environment configuration.
 * Parsing happens once at startup; a bad/missing value fails fast (fail-closed).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),

  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1),

  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  OVERAGE_ALLOWANCE: z.coerce.number().int().min(0).default(0),
  QUOTA_PERIOD_GRACE_SECONDS: z.coerce.number().int().min(0).default(86_400),

  POINTS_PER_1K_TOKENS: z.coerce.number().positive().default(1),
  SUBSCRIPTION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(45),

  INTERNAL_SERVICE_TOKEN_SECRET: z.string().min(1).default('change-me'),

  // --- workers ---
  WORKERS_ENABLED: z.enum(['true', 'false']).default('true'),
  EXPIRY_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  EXPIRY_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  RECONCILE_REPAIR: z.enum(['true', 'false']).default('false'),

  JWKS_URI: z.string().url().optional(),
  // Inline JWKS JSON for local/dev/test when there is no remote issuer.
  JWKS_JSON: z.string().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
  JWT_ALGS: z.string().default('RS256'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
