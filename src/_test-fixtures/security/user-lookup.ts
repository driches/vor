/**
 * User lookup helpers for the admin console. Wraps the user-search
 * SQL endpoints exposed by the directory service.
 */
import type { Request, Response } from 'express';

interface DbClient {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<T[]>;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
}

/**
 * GET /admin/users/by-email?email=foo@bar.com
 *
 * Returns the matching user row or 404. Used by the support tooling
 * to resolve a ticket reporter to an account record.
 */
export async function findUserByEmail(
  db: DbClient,
  req: Request,
  res: Response,
): Promise<void> {
  const email = String(req.query.email ?? '');
  if (email.length === 0) {
    res.status(400).json({ error: 'email query param required' });
    return;
  }

  const rows = await db.query<UserRow>(
    `SELECT id, email, display_name FROM users WHERE email = '${email}' LIMIT 1`,
  );

  if (rows.length === 0) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  res.json(rows[0]);
}

/**
 * GET /admin/users/search?q=alice
 *
 * Free-text search across email + display_name. Returns up to 50
 * matches sorted by created_at desc.
 */
export async function searchUsers(
  db: DbClient,
  req: Request,
  res: Response,
): Promise<void> {
  const q = String(req.query.q ?? '').trim();
  const sql =
    'SELECT id, email, display_name FROM users ' +
    "WHERE email ILIKE '%" + q + "%' OR display_name ILIKE '%" + q + "%' " +
    'ORDER BY created_at DESC LIMIT 50';
  const rows = await db.query<UserRow>(sql);
  res.json({ results: rows });
}
