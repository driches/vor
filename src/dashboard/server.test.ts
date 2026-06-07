import { describe, expect, it } from 'vitest';
import { csrfRejection, startDashboard } from './server.js';

describe('startDashboard bind guard', () => {
  it('refuses to bind to a non-loopback host', async () => {
    await expect(startDashboard({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/i);
    await expect(startDashboard({ port: 0, host: '192.168.1.10' })).rejects.toThrow(/loopback/i);
  });
});

describe('csrfRejection', () => {
  const port = 4310;

  it('allows GET regardless of headers', () => {
    expect(csrfRejection('GET', {}, port)).toBeNull();
  });

  it('rejects a non-JSON POST (blocks cross-site HTML form posts) with 415', () => {
    const r = csrfRejection('POST', { contentType: 'application/x-www-form-urlencoded' }, port);
    expect(r?.status).toBe(415);
  });

  it('rejects a JSON POST from a foreign origin with 403', () => {
    const r = csrfRejection(
      'POST',
      { contentType: 'application/json', origin: 'http://evil.example' },
      port,
    );
    expect(r?.status).toBe(403);
  });

  it('allows a same-origin loopback JSON POST', () => {
    expect(
      csrfRejection(
        'POST',
        { contentType: 'application/json', origin: `http://127.0.0.1:${port}` },
        port,
      ),
    ).toBeNull();
  });

  it('allows a JSON POST with no Origin header (non-browser client)', () => {
    expect(csrfRejection('POST', { contentType: 'application/json; charset=utf-8' }, port)).toBeNull();
  });
});
