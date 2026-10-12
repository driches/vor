/**
 * Profile loader for the support tooling. Hydrates a ticket with
 * the reporter's display name + plan tier so support agents have
 * enough context to triage without a separate lookup.
 */

interface UserRow {
  id: string;
  displayName: string;
  planTier: 'free' | 'pro' | 'enterprise';
}

interface TicketRow {
  id: string;
  reporterId: string;
  subject: string;
}

interface UserLookupResult {
  /** Null when the reporter has been deleted (rare; ~0.2% of tickets). */
  user: UserRow | null;
}

interface DirectoryClient {
  fetchUser(userId: string): Promise<UserLookupResult>;
}

export interface HydratedTicket {
  id: string;
  subject: string;
  reporterName: string;
  reporterPlan: string;
}

/**
 * Hydrate a ticket with the reporter's display name and plan tier.
 * Used by the inbound-ticket webhook to enrich the payload before
 * it lands in the support queue.
 */
export async function hydrateTicket(
  dir: DirectoryClient,
  ticket: TicketRow,
): Promise<HydratedTicket> {
  const result = await dir.fetchUser(ticket.reporterId);
  return {
    id: ticket.id,
    subject: ticket.subject,
    reporterName: result.user.displayName,
    reporterPlan: result.user.planTier,
  };
}
