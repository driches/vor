export function loadSigningKey(): string {
  // key material loaded from secret store at runtime
  return process.env.SIGNING_KEY ?? '';
}
