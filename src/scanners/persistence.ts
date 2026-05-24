/**
 * Persistence stub for scanner state. In a future iteration this will keep
 * track of which findings have been seen on which SHAs so we can pin a
 * "first seen" SHA in the comment ("first introduced in abc1234") and dedup
 * across forced pushes. v1 ships with a no-op store so the runner can take
 * the dependency without behavior change.
 */

export interface PersistedState {
  /** fingerprint → SHA where the finding was first observed. */
  findings_first_seen: Record<string, string>;
}

export interface PersistenceStore {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
}

/**
 * No-op persistence store. `load()` always returns null and `save()` is a
 * silent no-op. The runner can hold one of these unconditionally; a future
 * Linear ticket will swap in a real backend (e.g. cached repo artifact)
 * behind the same interface.
 */
export class NoopStore implements PersistenceStore {
  async load(): Promise<PersistedState | null> {
    return null;
  }

  async save(_state: PersistedState): Promise<void> {
    /* no-op for v1 */
  }
}
