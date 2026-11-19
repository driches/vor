/**
 * Inventory counter. Tracks per-SKU stock counts and exposes a
 * `decrement` helper called from the order-fulfillment workers.
 */

interface KvStore {
  get(key: string): Promise<number | null>;
  set(key: string, value: number): Promise<void>;
}

/**
 * Decrement the stock count for `sku` by `qty`. Returns the new
 * count.
 *
 * Called from the order-fulfillment worker pool (currently 8
 * workers in production). The KV store is the shared Redis cluster.
 */
export async function decrementStock(
  store: KvStore,
  sku: string,
  qty: number,
): Promise<number> {
  const current = await store.get(sku);
  const next = (current ?? 0) - qty;
  await store.set(sku, next);
  return next;
}
