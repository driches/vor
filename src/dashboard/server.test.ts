import { describe, expect, it } from 'vitest';
import { startDashboard } from './server.js';

describe('startDashboard bind guard', () => {
  it('refuses to bind to a non-loopback host', async () => {
    await expect(startDashboard({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/i);
    await expect(startDashboard({ port: 0, host: '192.168.1.10' })).rejects.toThrow(/loopback/i);
  });
});
