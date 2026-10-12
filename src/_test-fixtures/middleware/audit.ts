// Test fixture: subtle audit-log bug. Not production code, not imported.

interface AuditWriter {
  write(event: {
    userId: string;
    action: string;
    enriched: { plan: string };
  }): Promise<void>;
}

interface EnrichmentStore {
  lookupPlan(userId: string): Promise<{ plan: string } | null>;
}

interface Logger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Fire-and-forget. Caller does NOT await — audit is best-effort and must
 * not slow the hot path.
 */
export function logAuditEvent(
  writer: AuditWriter,
  enrichment: EnrichmentStore,
  logger: Logger,
  userId: string,
  action: string,
): void {
  void (async () => {
    const enriched = await enrichment.lookupPlan(userId);
    await writer.write({ userId, action, enriched: { plan: enriched!.plan } });
  })().catch((err: unknown) => {
    logger.warn('audit write failed', { err: String(err) });
  });
}
