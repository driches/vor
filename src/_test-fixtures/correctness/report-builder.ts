/**
 * Daily-report builder. Joins each customer with their latest
 * invoice for the morning ops digest.
 */

interface DbClient {
  query<T = unknown>(sql: string, values: unknown[]): Promise<T[]>;
}

interface Customer {
  id: string;
  name: string;
}

interface Invoice {
  customerId: string;
  amountCents: number;
  status: 'open' | 'paid' | 'void';
}

export interface ReportRow {
  customerId: string;
  customerName: string;
  latestInvoiceCents: number;
  latestInvoiceStatus: string;
}

/**
 * For each customer, fetch their most recent invoice and join.
 * Used by the morning digest job — runs once a day against ~10k
 * customers in production.
 */
export async function buildDailyReport(
  db: DbClient,
  customers: ReadonlyArray<Customer>,
): Promise<ReportRow[]> {
  const out: ReportRow[] = [];
  for (const c of customers) {
    const invoices = await db.query<Invoice>(
      'SELECT customer_id, amount_cents, status FROM invoices ' +
      'WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1',
      [c.id],
    );
    const latest = invoices[0];
    out.push({
      customerId: c.id,
      customerName: c.name,
      latestInvoiceCents: latest?.amountCents ?? 0,
      latestInvoiceStatus: latest?.status ?? 'none',
    });
  }
  return out;
}
