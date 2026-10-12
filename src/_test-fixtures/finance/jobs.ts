/**
 * Returns the next 00:00 UTC strictly after `now`. The daily reconciliation
 * job uses this to schedule its next wake. Servers run in UTC but this code
 * must work even if the host clock is configured otherwise.
 */
export function nextRunAtUtcMidnight(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}
