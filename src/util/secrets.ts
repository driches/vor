/**
 * Redacts secrets from any string before logging.
 * Registered secrets are replaced with `***`.
 */

const registered = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) {
    registered.add(value);
  }
}

export function redact(input: string): string {
  let out = input;
  for (const secret of registered) {
    if (secret.length === 0) continue;
    // Global replace without regex (secrets may contain regex metachars).
    out = out.split(secret).join('***');
  }
  return out;
}

/** For tests only. */
export function _clearRegisteredSecrets(): void {
  registered.clear();
}
