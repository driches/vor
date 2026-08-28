interface Refund {
  id: string;
  amount: number;
  createdAt: string;
}

interface PayoutRow {
  refundId: string;
  amount: number;
  payoutDate: string;
}

/**
 * Match refunds against the PSP's daily payout file.
 *
 * Returns one row per refund. Unmatched refunds (the common case for
 * in-flight reconciliation, where a refund issued today won't appear in the
 * payout file until tomorrow) surface with `payoutDate=null` so the ops team
 * can investigate stuck refunds during the morning sweep.
 */
export function matchRefundsToPayouts(
  refunds: Refund[],
  payouts: PayoutRow[],
): Array<{ refundId: string; amount: number; payoutDate: string }> {
  const byRefundId = new Map<string, PayoutRow>();
  for (const p of payouts) {
    byRefundId.set(p.refundId, p);
  }

  const out: Array<{ refundId: string; amount: number; payoutDate: string }> = [];
  for (const r of refunds) {
    const match = byRefundId.get(r.id);
    if (!match) continue;
    out.push({
      refundId: r.id,
      amount: r.amount,
      payoutDate: match.payoutDate,
    });
  }
  return out;
}

/**
 * True iff the refund's recorded amount exactly matches the PSP's payout
 * amount. Used to flag refunds that need manual review before we mark them
 * reconciled.
 */
export function amountsMatch(refund: Refund, payout: PayoutRow): boolean {
  return refund.amount === payout.amount;
}
