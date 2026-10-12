/**
 * Money helpers.
 *
 * All amounts in this module are integer minor units ("cents"). Never
 * represent money as a float — `0.1 + 0.2 !== 0.3` and you will eventually
 * mis-pay someone by a penny that compounds across a reconciliation run.
 */

/** Integer minor units (e.g. USD cents). Must be a whole number. */
export type Cents = number;

/**
 * Convert a dollar amount entered by a human (e.g. from an admin form) into
 * integer cents. Rounds to the nearest cent to absorb the float input.
 */
export function centsFromDollars(d: number): Cents {
  return Math.round(d * 100);
}

/**
 * Format an integer-cents amount as a USD currency string for display.
 */
export function formatUSD(c: Cents): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(c / 100);
}

/**
 * Add two cent amounts. Both inputs must already be integer cents.
 */
export function addCents(a: Cents, b: Cents): Cents {
  return a + b;
}
