/**
 * Smoke-test sampler. Six intentionally planted vulnerabilities across the
 * scanner and AI-agent review paths to verify the code-review action catches
 * a diverse set of bug shapes end-to-end. Reverted after observation.
 *
 * Plants (with expected detector):
 *   1. AWS access key id      → secrets scanner (regex)
 *   2. GitHub PAT (classic)   → secrets scanner (regex)
 *   3. PEM private key block  → secrets scanner (regex)
 *   4. SQL injection          → AI agent (semantic)
 *   5. Path traversal         → AI agent (semantic)
 *   6. eval(user input)       → AI agent (semantic)
 */

// 1) Hardcoded AWS access key. Should match `secret:aws-access-key-id`.
export const AWS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';

// 2) Hardcoded GitHub Personal Access Token (classic prefix).
export const GH_TOKEN = 'ghp_smokeTestFixture1234567890ABCDEFGHIJ';

// 3) Hardcoded PEM private-key block. The scanner anchors on `-----BEGIN`.
export const SIGNING_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDxxFakeFakeFake
-----END PRIVATE KEY-----`;

// 4) SQL injection via template literal. The AI agent should flag the
//    unsanitized `userId` interpolation into the query string.
export async function getUser(
  db: { query: (sql: string) => Promise<unknown[]> },
  userId: string,
): Promise<unknown> {
  const rows = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);
  return rows[0];
}

// 5) Path traversal — `req.params.filename` flows untrusted into `readFile`.
//    The AI agent should flag the missing path normalization / allowlist.
import { readFile } from 'node:fs/promises';
export async function serveUpload(req: { params: { filename: string } }): Promise<Buffer> {
  return readFile(`./uploads/${req.params.filename}`);
}

// 6) eval() on user-supplied code. Should be flagged as remote code execution.
export function runUserScript(req: { body: { code: string } }): unknown {
  // eslint-disable-next-line no-eval
  return eval(req.body.code);
}
