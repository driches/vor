/**
 * Shared helper for the `--scanner-findings-in-user-prompt` flag wiring.
 *
 * Originally each eval harness inlined the synthetic config as:
 *
 *   `experimental:\n  scanner_findings_in_user_prompt: true\n`
 *
 * That has two problems Codex caught on PR #34:
 *
 *  1. It MASKS the repository's real `.code-review.yml`. Anything else the
 *     repo configured (severity floor, exclude paths, scanner enable flags)
 *     is silently lost when the FakeOctokit serves the synthetic file instead
 *     of the real one.
 *  2. The `experimental.scanner_findings_in_user_prompt` key may not exist
 *     in the current branch's schema (PR #34 lives on a main-based branch;
 *     the implementation is on PR #36). When the schema doesn't have the
 *     key, Zod silently strips it on load and the flag is a no-op — but the
 *     CLI advertises behavior that isn't happening.
 *
 * This helper fixes both: merge the experimental key into whatever YAML the
 * repo already has, and post-validate via the real `loadConfigFromString`
 * so we can emit a clear warning when the flag has no effect on the current
 * branch.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfigFromString } from '../../src/config/loader.js';
import type { ReviewConfig } from '../../src/config/types.js';

export interface FlagInjectionResult {
  /** Merged YAML to serve from the FakeOctokit's `.code-review.yml` path. */
  mergedYaml: string;
  /** Whether the resulting `ReviewConfig` actually has the flag set. */
  effective: boolean;
  /** The schema-validated `ReviewConfig` the orchestrator will see. */
  effectiveConfig: ReviewConfig;
}

/**
 * Merge `scanner_findings_in_user_prompt: true` into whatever YAML the
 * repository already has. Returns the merged YAML alongside an "effective"
 * flag so the caller can warn loudly when the flag had no schema-level
 * effect.
 *
 * `existingYaml` may be `null` (no `.code-review.yml` in the repo) — in that
 * case the merge produces a YAML containing only the experimental key.
 */
export function injectScannerFindingsFlag(existingYaml: string | null): FlagInjectionResult {
  // Parse the existing YAML (or start from an empty object). We can't use
  // loadConfigFromString here because it expands to the full DEFAULT_CONFIG;
  // we only want to MERGE the flag on top, not write back all defaults.
  let parsed: Record<string, unknown> = {};
  if (existingYaml && existingYaml.trim().length > 0) {
    try {
      const raw = parseYaml(existingYaml);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      }
    } catch {
      // Malformed user YAML — degrade to empty rather than throwing. The
      // production loader will surface the same issue with a clearer message
      // when the orchestrator parses our merged output.
    }
  }
  // The `experimental` key may legitimately be missing, OR a repo may have
  // written something parseable-but-wrong-shape (e.g. `experimental: false`
  // or `experimental: "yes"`). The production config loader tolerates that
  // and falls back to defaults; matching that here keeps the flag from
  // turning an otherwise-runnable case into a per-case failure. Codex P2
  // #3313098982.
  const existing = parsed['experimental'];
  const experimental: Record<string, unknown> =
    existing !== null &&
    typeof existing === 'object' &&
    !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  experimental['scanner_findings_in_user_prompt'] = true;
  parsed['experimental'] = experimental;
  const mergedYaml = stringifyYaml(parsed);

  // Round-trip through the real loader to check whether the flag survives
  // schema validation. On a branch that doesn't define the key, Zod strips
  // it and `effective` reports false so the harness can emit a warning.
  const effectiveConfig = loadConfigFromString(mergedYaml);
  const effective =
    effectiveConfig.experimental != null &&
    'scanner_findings_in_user_prompt' in effectiveConfig.experimental &&
    (effectiveConfig.experimental as { scanner_findings_in_user_prompt?: boolean })
      .scanner_findings_in_user_prompt === true;

  return { mergedYaml, effective, effectiveConfig };
}
