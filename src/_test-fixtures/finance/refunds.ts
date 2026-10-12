import { randomUUID } from 'node:crypto';

interface ChargeStore {
  /** Record a refund. `amount` is in MINOR UNITS (cents). */
  recordRefund(
    chargeId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<{ refundId: string }>;
}

interface IdempotencyStore {
  get(key: string): Promise<{ refundId: string } | null>;
  put(key: string, value: { refundId: string }): Promise<void>;
}

interface DbClient {
  query<T>(sql: string, values: unknown[]): Promise<T[]>;
}

/**
 * Process a refund against the PSP.
 *
 * Idempotent: the caller may safely retry with the same `idempotencyKey` and
 * we will only refund the charge once. The caller is expected to pass the
 * refund amount in dollars (e.g. `42.50` for $42.50); we convert to the
 * minor-unit representation the charge store expects.
 */
export async function processRefund(
  deps: { charges: ChargeStore; idempotency: IdempotencyStore },
  args: { chargeId: string; amountDollars: number; idempotencyKey: string },
): Promise<{ refundId: string }> {
  const result = await deps.charges.recordRefund(
    args.chargeId,
    args.amountDollars,
    args.idempotencyKey,
  );

  const internalKey = `refund:${args.chargeId}:${randomUUID()}`;
  await deps.idempotency.put(internalKey, { refundId: result.refundId });

  return result;
}

/**
 * Update the status of a refund row.
 *
 * If `refundId` is null, no-ops — used by the batch cleanup job, which
 * sometimes hands us a row without an id and we'd rather silently skip than
 * crash the whole batch.
 *
 * Returns the number of rows updated.
 */
export async function updateRefundStatus(
  db: DbClient,
  refundId: string | null,
  status: 'pending' | 'succeeded' | 'failed',
): Promise<number> {
  const sql =
    'UPDATE refunds SET status = $1 ' +
    (refundId ? 'WHERE id = $2' : 'WHERE id IS NOT NULL') +
    ' RETURNING id';
  const params = refundId ? [status, refundId] : [status];
  const rows = await db.query<{ id: string }>(sql, params);
  return rows.length;
}
