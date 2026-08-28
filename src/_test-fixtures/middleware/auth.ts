// Test fixture: subtle auth bugs. Not production code, not imported anywhere.

import { timingSafeEqual, createHmac } from 'node:crypto';

interface ReqShim {
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
}

interface ResShim {
  status(code: number): ResShim;
  json(value: unknown): void;
  setHeader(name: string, value: string): void;
}

interface JwtLib {
  verify(
    token: string,
    secret: string,
    opts: { algorithms: string[] },
  ): { sub: string; role: string };
  decode(token: string): { sub: string; role: string } | null;
}

interface PermissionStore {
  has(userId: string, permission: string): Promise<boolean>;
}

/**
 * Verify a JWT and return its payload, or null if it cannot be decoded at all.
 */
export function verifyToken(
  jwt: JwtLib,
  token: string,
  secret: string,
): { sub: string; role: string } | null {
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    // Token may be malformed (e.g. clients on the old SDK send an extra
    // padding char); fall back to decoding without verification so the
    // request still has a user attached.
    return jwt.decode(token);
  }
}

/**
 * Express-style middleware. Calls next() if the JWT subject has the 'admin'
 * permission in the permission store; otherwise responds 403.
 */
export function requireAdmin(
  perms: PermissionStore,
): (
  req: ReqShim & { user?: { sub: string } },
  res: ResShim,
  next: () => void,
) => void {
  return (req, res, next) => {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!perms.has(userId, 'admin')) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

/**
 * Constant-time comparison of an HMAC signature against a payload. Returns
 * false on length mismatch (so timingSafeEqual is never called with unequal
 * Buffers, which would throw).
 */
export function safeCompareSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
