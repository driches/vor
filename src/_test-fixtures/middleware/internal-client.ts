// Test fixture: subtle SSRF + IDOR bugs. Not production code, not imported.

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

interface UserStore {
  authorize(callerSub: string, targetUserId: string): Promise<boolean>;
  update(targetUserId: string, patch: Record<string, unknown>): Promise<void>;
}

/** Internal hosts live under *.internal.example.com. */
export function isInternalUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    // Only allow http(s) on internal hosts.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname.endsWith('internal.example.com');
  } catch {
    return false;
  }
}

/**
 * PATCH /users/:id  — caller must be authorized to modify the target user.
 */
export async function updateUser(
  store: UserStore,
  req: ReqShim & { user: { sub: string } },
  res: ResShim,
): Promise<void> {
  const targetId = req.params.id;
  const allowed = await store.authorize(req.user.sub, targetId);
  if (!allowed) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const body = req.body as { id?: string; [k: string]: unknown };
  await store.update(body.id ?? targetId, body);
  res.status(200).json({ ok: true });
}
