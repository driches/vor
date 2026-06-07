import { describe, expect, it } from 'vitest';
import { csrfRejection, hostForUrl, startDashboard } from './server.js';

describe('hostForUrl', () => {
  it('brackets IPv6 literals and leaves IPv4/hostnames alone', () => {
    expect(hostForUrl('::1')).toBe('[::1]');
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1');
    expect(hostForUrl('localhost')).toBe('localhost');
    expect(hostForUrl('[::1]')).toBe('[::1]'); // already bracketed
  });

  it('produces a URL Node can parse for an IPv6 host', () => {
    expect(() => new URL('/api/runs', `http://${hostForUrl('::1')}:4310`)).not.toThrow();
  });
});

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
