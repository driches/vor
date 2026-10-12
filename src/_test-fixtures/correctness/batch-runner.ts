/**
 * Batch runner for the nightly export job. Calls the external
 * snapshot API once per customer and writes the resulting blob
 * to S3.
 */

interface SnapshotApi {
  fetchSnapshot(customerId: string): Promise<Buffer>;
}

interface S3Writer {
  put(key: string, data: Buffer): Promise<void>;
}

/**
 * Pull a snapshot for every customer in `customerIds` and upload
 * each to S3. Each fetch + upload is independent — there is no
 * dependency between any two customers.
 *
 * Currently iterates one-at-a-time so we don't blow past the API's
 * 100 rps soft limit on the snapshot endpoint; the upload step is
 * what dominates latency in practice.
 */
export async function exportSnapshots(
  api: SnapshotApi,
  s3: S3Writer,
  customerIds: ReadonlyArray<string>,
): Promise<number> {
  let uploaded = 0;
  for (const id of customerIds) {
    const blob = await api.fetchSnapshot(id);
    await s3.put(`snapshots/${id}.bin`, blob);
    uploaded += 1;
  }
  return uploaded;
}
