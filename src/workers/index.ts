import { env } from '../config/env';
import { logger } from '../utils/logger';
import { Leader } from './leader';
import { sweepExpiredReservations } from './expiry.worker';
import { reconcileOnce } from './reconciliation.worker';

let timers: NodeJS.Timeout[] = [];

/**
 * Starts the background workers on intervals, each guarded by its own leader lock so
 * only one replica runs it. No-op when WORKERS_ENABLED=false (e.g. a dedicated
 * worker Deployment vs the request-serving Deployment).
 */
export function startWorkers(): void {
  if (env.WORKERS_ENABLED !== 'true') {
    logger.info('workers disabled (WORKERS_ENABLED=false)');
    return;
  }

  const expiryLeader = new Leader('lock:worker:expiry', env.EXPIRY_SWEEP_INTERVAL_SECONDS * 2 * 1000);
  const reconcileLeader = new Leader('lock:worker:reconcile', env.RECONCILE_INTERVAL_SECONDS * 2 * 1000);

  const expiryTimer = setInterval(() => {
    void (async () => {
      try {
        if (await expiryLeader.isLeader()) await sweepExpiredReservations();
      } catch (err) {
        logger.error({ err }, 'expiry tick failed');
      }
    })();
  }, env.EXPIRY_SWEEP_INTERVAL_SECONDS * 1000);

  const reconcileTimer = setInterval(() => {
    void (async () => {
      try {
        if (await reconcileLeader.isLeader()) await reconcileOnce();
      } catch (err) {
        logger.error({ err }, 'reconcile tick failed');
      }
    })();
  }, env.RECONCILE_INTERVAL_SECONDS * 1000);

  expiryTimer.unref();
  reconcileTimer.unref();
  timers = [expiryTimer, reconcileTimer];
  logger.info(
    { expirySec: env.EXPIRY_SWEEP_INTERVAL_SECONDS, reconcileSec: env.RECONCILE_INTERVAL_SECONDS },
    'workers started',
  );
}

export function stopWorkers(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}
