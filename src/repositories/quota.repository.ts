import { pool } from '../database/pool';

export interface ReservationRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  request_id: string;
  operation: string;
  estimated_units: string;
  actual_units: string | null;
  status: string;
  expires_at: Date;
}

export type LedgerEntryType = 'commit' | 'release' | 'adjustment' | 'refund';
export type ReservationStatus = 'committed' | 'released' | 'expired';

/**
 * Persist a reservation and its ledger entry idempotently. UNIQUE(request_id) and
 * UNIQUE(request_id, entry_type) make repeated auth subrequests safe (spec D3).
 */
export async function insertReservation(params: {
  tenantId: string;
  subscriptionId: string;
  requestId: string;
  operation: string;
  estimatedUnits: number;
  expiresAt: Date;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO quota_reservations
         (tenant_id, subscription_id, request_id, operation, estimated_units, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,'reserved',$6)
       ON CONFLICT (request_id) DO NOTHING`,
      [params.tenantId, params.subscriptionId, params.requestId, params.operation, params.estimatedUnits, params.expiresAt],
    );
    await client.query(
      `INSERT INTO usage_ledger
         (tenant_id, subscription_id, reservation_id, request_id, operation, units, entry_type, status)
       SELECT $1,$2, r.id, $3,$4,$5,'reservation','reserved'
         FROM quota_reservations r WHERE r.request_id = $3
       ON CONFLICT (request_id, entry_type) DO NOTHING`,
      [params.tenantId, params.subscriptionId, params.requestId, params.operation, params.estimatedUnits],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findReservationByRequestId(requestId: string): Promise<ReservationRow | null> {
  const { rows } = await pool.query<ReservationRow>(
    `SELECT id, tenant_id, subscription_id, request_id, operation, estimated_units, actual_units, status, expires_at
       FROM quota_reservations WHERE request_id = $1`,
    [requestId],
  );
  return rows[0] ?? null;
}

/** Reservations still holding units past their expiry — driven by the expiry worker. */
export async function findExpiredReservations(limit: number): Promise<ReservationRow[]> {
  const { rows } = await pool.query<ReservationRow>(
    `SELECT id, tenant_id, subscription_id, request_id, operation, estimated_units, actual_units, status, expires_at
       FROM quota_reservations
      WHERE status = 'reserved' AND expires_at < now()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Sum of currently-held (reserved) units for a subscription (reconciliation). */
export async function sumReservedUnits(subscriptionId: string): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(estimated_units), 0) AS total
       FROM quota_reservations WHERE subscription_id = $1 AND status = 'reserved'`,
    [subscriptionId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Sum of settled (committed/adjustment) units from the ledger for a subscription. */
export async function sumCommittedUnits(subscriptionId: string): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(units), 0) AS total
       FROM usage_ledger WHERE subscription_id = $1 AND entry_type IN ('commit','adjustment')`,
    [subscriptionId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Settle a reservation in one transaction: transition its status, record actual units,
 * and append an immutable ledger entry. Idempotent via ON CONFLICT (request_id, entry_type).
 */
export async function recordSettlement(params: {
  row: ReservationRow;
  newStatus: ReservationStatus;
  actualUnits: number | null;
  entryType: LedgerEntryType;
  ledgerUnits: number;
  ledgerStatus: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only transition out of a non-terminal state (idempotent / race-safe).
    await client.query(
      `UPDATE quota_reservations
          SET status = $2, actual_units = COALESCE($3, actual_units), updated_at = now()
        WHERE request_id = $1 AND status IN ('reserved','expired')`,
      [params.row.request_id, params.newStatus, params.actualUnits],
    );
    await client.query(
      `INSERT INTO usage_ledger
         (tenant_id, subscription_id, reservation_id, request_id, operation, units, entry_type, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (request_id, entry_type) DO NOTHING`,
      [
        params.row.tenant_id,
        params.row.subscription_id,
        params.row.id,
        params.row.request_id,
        params.row.operation,
        params.ledgerUnits,
        params.entryType,
        params.ledgerStatus,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
