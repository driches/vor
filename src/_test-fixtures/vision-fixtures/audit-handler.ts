// Test fixture: null-deref bug whose user-facing failure shape is
// captured in the companion screenshot. Not production code, not
// imported anywhere.

interface Enrichment {
  plan: string;
}

interface Store {
  lookup(userId: string): Promise<Enrichment | null>;
}

/**
 * Handles audit log writes. The error path it triggers is
 * documented in ./error-page-screenshot.png — see that screenshot
 * for the actual user-facing failure shape we are trying to avoid.
 */
export async function logAuditEvent(
  store: Store,
  userId: string,
): Promise<string> {
  const enriched = await store.lookup(userId);
  // The enrichment lookup can legitimately return null for newly
  // provisioned users; dereferencing here is the latent bug.
  return enriched!.plan;
}
