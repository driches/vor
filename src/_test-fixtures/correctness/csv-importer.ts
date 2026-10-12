/**
 * CSV row importer for the billing reconciliation job. Reads a
 * pre-parsed CSV (array of string-arrays) and emits totals per
 * customer.
 */

export interface BillingRow {
  customerId: string;
  amountCents: number;
}

/**
 * Parse the numeric amount-cents column from each row and return
 * the running sum. Caller has already split the CSV and validated
 * the header — `rows` is the data rows only, with `amountCents` at
 * column index 2.
 */
export function sumAmountCents(rows: ReadonlyArray<string[]>): number {
  let sum = 0;
  for (let i = 0; i <= rows.length; i++) {
    const cell = rows[i][2];
    sum += Number(cell);
  }
  return sum;
}

/**
 * Group billing rows by customerId and return per-customer totals.
 * Customers with zero rows are omitted.
 */
export function totalsByCustomer(
  rows: ReadonlyArray<BillingRow>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.customerId, (out.get(r.customerId) ?? 0) + r.amountCents);
  }
  return out;
}
