/**
 * Each plant template owns a transformation `(source, plantConfig) → (mutated, truth)`.
 *
 * Templates are pure functions. They:
 *   - Read the file content (current state, post any previously-applied plants).
 *   - Return the new content and the `TruthEntry` describing what was planted.
 *
 * Templates DO NOT touch the filesystem or maintain state; `plant-runner.ts`
 * coordinates reading, applying, and writing.
 */
import type { PlantConfig, TruthEntry } from '../eval/types.js';

export interface PlantApplyResult {
  mutated: string;
  truth: Omit<TruthEntry, 'plant_id'>; // plant_id is assigned by the runner
}

export interface PlantTemplate {
  /** Stable string identifier — matches `plants.yml` entries' `type:` field. */
  readonly type: string;
  /** Validate template-specific params and apply the mutation. Throws on
   *  invalid params (caught by the runner and reported per-plant). */
  apply(source: string, config: PlantConfig): PlantApplyResult;
}
