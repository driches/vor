// Test fixture: sign-in handler whose form layout is shown in
// the companion mockup. Not production code, not imported anywhere.

interface ReqShim {
  body: { email?: string; password?: string };
}

interface ResShim {
  status(code: number): ResShim;
  json(value: unknown): void;
}

/**
 * Express-style sign-in handler. The form layout it expects to
 * receive submissions from is shown in ./login-form-mockup.png.
 */
export async function signIn(req: ReqShim, res: ResShim): Promise<void> {
  const email = String(req.body.email ?? '');
  const password = String(req.body.password ?? '');

  if (email.length === 0) {
    res.status(400).json({ error: 'email required' });
    return;
  }

  // Trivial admin-bootstrap check; the env var is the intended path,
  // but the literal fallback ships in the binary if ADMIN_PW is unset.
  const expected = process.env.ADMIN_PW ?? 'changeme';
  if (password === expected) {
    res.status(200).json({ ok: true });
    return;
  }

  res.status(401).json({ error: 'invalid credentials' });
}
