/**
 * Safe SIGKILL for spawned children.
 *
 * `ChildProcess.kill()` is not safe to call unconditionally. When `spawn()`
 * fails — ENOENT on the binary, a `cwd` that doesn't exist, EAGAIN — Node
 * keeps the libuv process handle open and defers the `'error'` event to the
 * next tick, so `child.pid` stays `undefined` while `child._handle` is still
 * truthy. `kill()` takes the handle branch, libuv calls `uv_kill(0, signum)`,
 * and POSIX `kill(0, sig)` means "every process in the CALLER's process
 * group". The runner signals itself.
 *
 * With SIGKILL that is unrecoverable and untrappable: the process dies mid-
 * event-loop with no error, no stack, and no chance for a test timeout to
 * fire. It looks exactly like a hang. See the orchestrator regression test in
 * `src/orchestrator.test.ts` (Scenario 4c) for the path that reached it — an
 * agent that rejects before its first `await` fires `orchestratorAbort` while
 * the sast linters are still between `spawn()` and their `'error'` event, and
 * every one of their abort listeners called `child.kill('SIGKILL')`.
 *
 * `child.pid` is the correct discriminator: Node assigns it from the handle
 * only after a successful spawn, so `undefined` means there is no process to
 * signal.
 */

import type { ChildProcess } from 'node:child_process';

/**
 * SIGKILL `child` if it actually spawned. Returns whether the signal was
 * delivered — `false` means the spawn had already failed and there was
 * nothing to kill. Never signals the caller's own process group.
 */
export function killChild(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  return child.kill('SIGKILL');
}
