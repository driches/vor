/**
 * Smoke-test fixture for the code-review action. Contains intentional bugs.
 * Two planted issues to exercise both review paths:
 *   1. Hardcoded AWS access key   → secrets scanner should catch this
 *   2. SQL string interpolation   → AI agent should catch this
 *
 * Reverted after the smoke test confirms the action works end-to-end.
 */

// Bug 1: hardcoded credential. The secrets scanner should flag this.
export const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

interface User {
  id: string;
  name: string;
}

// Bug 2: SQL injection via template literal. The AI agent should flag this.
export async function getUser(db: { query: (sql: string) => Promise<User[]> }, userId: string): Promise<User | null> {
  const result = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);
  return result[0] ?? null;
}
