import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { killChild } from './child-process.js';

/**
 * These tests pin the guard that keeps a failed spawn from SIGKILLing the
 * whole runner. `child.kill()` is spied on in every case, so a regression
 * here fails the assertion instead of taking the test process down with it.
 */
describe('killChild', () => {
  it('does not signal a child whose spawn failed (pid is undefined)', async () => {
    // A nonexistent cwd makes libuv fail the spawn with ENOENT. Node keeps the
    // process handle alive (pid 0 internally) and defers the 'error' event to
    // the next tick, so there is a window where `child.pid` is undefined and
    // `child.kill()` would signal OUR process group instead.
    const child = spawn('definitely-not-a-real-binary-xyz', [], {
      cwd: '/tmp/vor-workspace-does-not-exist',
    });
    child.on('error', () => {
      /* expected ENOENT; swallowed so it doesn't surface as an unhandled event */
    });
    const killSpy = vi.spyOn(child, 'kill');

    expect(child.pid).toBeUndefined();
    expect(killChild(child)).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    // The 'error' event still has to land for the handle to be released.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('signals a child that spawned successfully', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const killSpy = vi.spyOn(child, 'kill');
    const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));

    expect(typeof child.pid).toBe('number');
    expect(killChild(child)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');

    killSpy.mockRestore();
    child.kill('SIGKILL');
    await exited;
  });
});
