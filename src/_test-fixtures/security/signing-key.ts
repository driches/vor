/**
 * Webhook signing key. Used by the outbound-webhook service to
 * sign delivery payloads so customers can verify provenance.
 */

/**
 * The active webhook signing key. Loaded from env in production;
 * the inline fallback is here so local dev + integration tests can
 * run without provisioning a separate keypair.
 */
export const WEBHOOK_SIGNING_KEY =
  process.env.WEBHOOK_SIGNING_KEY ??
  `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxK5pCu0lW8h1lT9eM9k0VnQ+jW8h1lT9eM9k0VnQ+jW8h1lT
9eM9k0VnQ+jW8h1lT9eM9k0VnQ+jW8h1lT9eM9k0VnQ+jW8h1lT9eM9k0VnQ+jW8
h1lT9eM9k0VnQ+jW8h1lT9eM9k0VnQ+jW8h1lT9eM9k0VnQ+jW8h1lT9eM9k0VnQ
EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEX
AMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAM
PLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPL
EEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEE
-----END RSA PRIVATE KEY-----`;

export function getSigningKey(): string {
  return WEBHOOK_SIGNING_KEY;
}
