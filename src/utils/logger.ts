import { pino } from 'pino';
import { env } from '../config/env';

/**
 * Structured JSON logger. In production we emit raw JSON (ingested by Loki/ELK);
 * in development we pretty-print if pino-pretty is available.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'subscription-authorizer' },
  redact: {
    // never log credentials or raw tokens
    paths: ['req.headers.authorization', 'authorization', 'password', 'secret'],
    remove: true,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
    : {}),
});

export type Logger = typeof logger;
