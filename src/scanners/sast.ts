/**
 * v1 stub for the SAST (static analysis) scanner.
 *
 * SAST is deferred — see the plan v2 scope doc. The slot is kept so the
 * config schema, registry, and runner can remain stable as soon as the real
 * implementation lands. The stub always opts out via `applies() === false`
 * so it never runs, and `scan()` returns an empty result tagged with the
 * correct {@link ScannerId} on the off-chance a caller invokes it directly.
 */
import type { Scanner } from './types.js';
import { emptyResult } from './types.js';

export const sastScannerStub: Scanner = {
  id: 'sast',
  applies: () => false,
  scan: async () => emptyResult('sast'),
};
