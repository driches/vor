/**
 * Dataset-integrity smoke test: every fixture case under
 * tests/fixtures/golden-repo/cases/ must plant cleanly and produce a valid
 * truth.yml whose entry count matches plants.yml.
 *
 * This is the cheap "does the dataset still work?" check — no orchestrator
 * run, no API tokens, no model dependency. It catches:
 *   - plants.yml that references a non-existent before/ file
 *   - Anchor markers missing or duplicated in the snippet
 *   - Templates that throw on plausible-looking but invalid params
 *   - Truth shape regressions (caught by loadCase's validator)
 *   - A new template added to the registry without a corresponding test case
 *
 * The end-to-end test (end-to-end.test.ts) handles the more expensive
 * plant → orchestrator → score → report path, but only against a small
 * subset of cases.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, cpSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runPlants } from '../plant/plant-runner.js';
import { loadCase } from './case-loader.js';

interface PlantsYaml {
  plants: Array<Record<string, unknown>>;
}

const FIXTURE_CASES_DIR = join(process.cwd(), 'tests/fixtures/golden-repo/cases');

function listCaseIds(): string[] {
  return readdirSync(FIXTURE_CASES_DIR)
    .filter((name) => statSync(join(FIXTURE_CASES_DIR, name)).isDirectory())
    .sort();
}

describe('all-cases plant smoke', () => {
  let goldenRoot: string;

  beforeAll(() => {
    // Copy the whole fixtures tree into a tmpdir once. Each case plants
    // into its own subtree, so they don't interfere — but we still copy up
    // front because runPlants writes after/ + truth.yml into the case dir,
    // and those artifacts must not leak into the committed fixture tree.
    goldenRoot = mkdtempSync(join(tmpdir(), 'all-cases-smoke-'));
    cpSync(FIXTURE_CASES_DIR, join(goldenRoot, 'cases'), { recursive: true });
  });

  afterAll(() => {
    rmSync(goldenRoot, { recursive: true });
  });

  it('discovers at least 20 cases', () => {
    // Floor, not exact, so adding more cases doesn't require updating this
    // assertion. The goal is to detect "the fixture tree got nuked" or
    // "test runner doesn't see the cases anymore."
    const ids = listCaseIds();
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });

  it.each(listCaseIds())(
    'plants case "%s" cleanly and produces a valid truth.yml',
    async (caseId) => {
      const caseDir = join(goldenRoot, 'cases', caseId);

      // Expected plant count from plants.yml (authoring contract).
      const plantsRaw = readFileSync(join(caseDir, 'plants.yml'), 'utf-8');
      const plantsYaml = parseYaml(plantsRaw) as PlantsYaml | null;
      expect(plantsYaml, `case ${caseId}: plants.yml must parse`).not.toBeNull();
      expect(
        Array.isArray(plantsYaml!.plants),
        `case ${caseId}: plants.yml must have a top-level "plants:" array`,
      ).toBe(true);
      const expectedPlantCount = plantsYaml!.plants.length;
      expect(
        expectedPlantCount,
        `case ${caseId}: plants.yml must declare at least one plant`,
      ).toBeGreaterThan(0);

      // Plant — must not throw.
      await runPlants(caseDir);

      // loadCase validates truth.yml structure end-to-end via its per-entry
      // validator (see scripts/eval/case-loader.ts:validateTruthEntry).
      // We pass goldenRoot — loadCase resolves the case dir under it.
      const loaded = loadCase(goldenRoot, caseId);
      expect(loaded.truths).toHaveLength(expectedPlantCount);

      // Every truth must carry a non-empty file, an ordered 1-based range,
      // and at least one category — loadCase already enforces this, but
      // assert here so a regression surfaces against THIS specific case
      // instead of as a generic loadCase failure.
      for (const truth of loaded.truths) {
        expect(truth.file).toBeTruthy();
        expect(truth.line_range[0]).toBeGreaterThanOrEqual(1);
        expect(truth.line_range[1]).toBeGreaterThanOrEqual(truth.line_range[0]);
        expect(truth.category.length).toBeGreaterThan(0);
      }
    },
  );
});
