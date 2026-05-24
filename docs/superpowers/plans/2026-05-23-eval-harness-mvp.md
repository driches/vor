# Eval Harness MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end synthetic-bug eval harness that runs the existing orchestrator against a golden case under named model configs, scores the output against planted truth, and renders a markdown comparison report.

**Architecture:** New `scripts/` directory holds the building blocks + a working `golden:plant` CLI + a scripted-agent integration test that proves the eval pipeline end-to-end. The orchestrator-adapter is test-only (uses `vi.mock`). No changes to `src/` runtime code. Plant catalog ships 3 templates (aws-access-key, sql-injection, vuln-dep:npm) — enough to exercise all three detection paths.

**Out of scope for this plan** (follow-up plan): a production `golden:eval` CLI that hits the real Anthropic API. That requires a small refactor of `src/orchestrator.ts` to extract a DI-friendly `runOrchestratorCore` (skip GitHub fetch, accept pre-built `prContext`, route `postReview` to a capture handler). Designed separately so we can re-use the existing scripted-agent test harness pattern.

**What this plan delivers:** 3 config files, the plant catalog + runner + CLI, the case loader, the test-only orchestrator adapter, scoring + report renderer + an integration test that goes plant→load→run→score→render with a scripted agent. After this plan, you can:
- Author golden cases and plant bugs into them (`npm run golden:plant`)
- Run scripted-agent tests against any case to validate the eval pipeline
- Render comparison reports from canned `ScoreResult` arrays
- Hand to a follow-up plan that adds the orchestrator DI seam and wires real Anthropic calls behind `golden:eval`

**Tech Stack:** TypeScript + tsx (existing), Zod (existing), yaml package (existing), vitest (existing). No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-23-eval-harness-design.md`.

---

## File structure

```
configs/pipeline/
  sonnet-only.yml
  opus-only.yml
  haiku-only.yml

scripts/
  eval.ts                              # CLI entry: golden:eval
  plant.ts                             # CLI entry: golden:plant
  render-report.ts                     # CLI entry: golden:render

  eval/
    types.ts                           # shared interfaces (RunRecord, ScoreResult, etc.)
    config-loader.ts                   # parse configs/pipeline/*.yml → ReviewConfig
    config-loader.test.ts
    case-loader.ts                     # read GOLDEN_REPO/cases/<id>/{after,truth}
    case-loader.test.ts
    orchestrator-adapter.ts            # invoke runOrchestrator against synthetic PR
    orchestrator-adapter.test.ts
    scoring.ts                         # match findings → truth, compute metrics
    scoring.test.ts
    report.ts                          # render markdown table
    report.test.ts

  plant/
    types.ts                           # PlantTemplate interface
    aws-access-key.ts
    aws-access-key.test.ts
    sql-injection.ts
    sql-injection.test.ts
    vuln-dep-npm.ts
    vuln-dep-npm.test.ts
    registry.ts                        # map plant type string → template
    plant-runner.ts                    # main entry — read plants.yml, apply in order
    plant-runner.test.ts

tests/fixtures/golden-repo/            # fixture for the e2e integration test
  cases/example/
    before/
      src/auth.ts
      src/db.ts
      package-lock.json
    plants.yml
```

## Conventions used throughout

- **Imports use `.js` extensions** (the project's ESM convention — TS files import as `.js`).
- **All commands use `npx tsx` for scripts** (matches project's existing `scripts/build.ts`, `scripts/verify-dist.ts`).
- **Tests run via `npx vitest run <file>` for individual files.** The full suite uses `npm test`.
- **Each task ends with a commit.** Use the message format shown.
- **TDD discipline:** write the failing test, run it to see it fail, write minimal code, run to see it pass, then commit.

---

## Task 1: Config files for the model matrix

**Files:**
- Create: `configs/pipeline/sonnet-only.yml`
- Create: `configs/pipeline/opus-only.yml`
- Create: `configs/pipeline/haiku-only.yml`

These are simple YAML — no tests. We rely on the config-loader's tests (Task 3) to validate them.

- [ ] **Step 1: Create `configs/pipeline/sonnet-only.yml`**

```yaml
# Baseline config — identical to current production default in src/config/defaults.ts.
# This is the reference everything else is compared against.
model: claude-sonnet-4-6
max_turns: 40
severity:
  floor: minor
  max_comments_per_file: 5
  max_comments_total: 30
budget:
  max_input_tokens: 500000
  max_output_tokens: 50000
```

- [ ] **Step 2: Create `configs/pipeline/opus-only.yml`**

```yaml
# Higher-capability ceiling for recall comparison. max_turns reduced because Opus
# tends to be more decisive per turn (and the per-turn cost is higher).
model: claude-opus-4-7
max_turns: 30
severity:
  floor: minor
  max_comments_per_file: 5
  max_comments_total: 30
budget:
  max_input_tokens: 500000
  max_output_tokens: 50000
```

- [ ] **Step 3: Create `configs/pipeline/haiku-only.yml`**

```yaml
# Low-cost floor for comparison. Same turn budget as sonnet — Haiku may need more
# back-and-forth to reach the same conclusion.
model: claude-haiku-4-5
max_turns: 40
severity:
  floor: minor
  max_comments_per_file: 5
  max_comments_total: 30
budget:
  max_input_tokens: 500000
  max_output_tokens: 50000
```

- [ ] **Step 4: Commit**

```bash
git add configs/pipeline/sonnet-only.yml configs/pipeline/opus-only.yml configs/pipeline/haiku-only.yml
git commit -m "feat(eval): add config matrix (sonnet-only, opus-only, haiku-only)"
```

---

## Task 2: Shared eval types

**Files:**
- Create: `scripts/eval/types.ts`

Pure type declarations — no tests directly (downstream tasks exercise them).

- [ ] **Step 1: Create `scripts/eval/types.ts`**

```ts
/**
 * Shared types for the eval harness.
 *
 * Boundaries:
 * - `PlantConfig` and `TruthEntry` are written by/read from YAML in the golden
 *   repo. They are also the I/O contract between `plant-runner.ts` and the
 *   individual `plant/templates/*.ts` files.
 * - `RunRecord` is the JSON shape persisted to `<case>/runs/<ts>-<config>.json`.
 *   Downstream `scoring.ts` and `render-report.ts` read it back.
 * - `ScoreResult` is produced by `scoring.ts` and consumed by `render-report.ts`.
 */
import type { PostedComment, Severity, Category } from '../../src/types.js';
import type { ReviewConfig } from '../../src/config/types.js';

/**
 * One entry in a case's `plants.yml` — what the case author wants planted.
 * Templates own the shape under `params`; we only know `type` here.
 */
export interface PlantConfig {
  type: string;
  file: string;
  // Templates accept arbitrary additional params. The template's TS function
  // validates these at apply time.
  [param: string]: unknown;
}

/**
 * One entry in a case's `truth.yml` — what the planter actually produced.
 * Generated by the templates; later consumed by scoring.
 */
export interface TruthEntry {
  file: string;
  line_range: readonly [number, number];
  bug_type: string;
  severity: Severity;
  plant_id: number;
  /** Categories that a finding's `category` may have to count as a match.
   *  E.g. for a secret plant: ['vulnerability', 'security']. */
  category: readonly Category[];
}

/**
 * Persisted output of one `runOrchestrator` invocation.
 */
export interface RunRecord {
  case_id: string;
  config_name: string;
  /** ISO timestamp string */
  timestamp: string;
  config_resolved: ReviewConfig;
  cost: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    cost_usd: number;
    turns: number;
    wall_ms: number;
    ended_reason: string;
  };
  findings: PostedComment[];
}

/**
 * Per-truth-entry scoring outcome.
 */
export type TruthOutcome =
  | { truth: TruthEntry; status: 'matched'; finding: PostedComment }
  | { truth: TruthEntry; status: 'missed' };

/**
 * One scored run (case × config). Consumed by the report renderer.
 */
export interface ScoreResult {
  case_id: string;
  config_name: string;
  recall: number;
  precision: number;
  f1: number;
  tp: number;
  fn: number;
  fp: number;
  cost_per_tp_usd: number;
  outcomes: TruthOutcome[];
  /** Findings that didn't map to any truth — noise candidates. */
  unaligned: PostedComment[];
  cost: RunRecord['cost'];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add scripts/eval/types.ts
git commit -m "feat(eval): shared types for plant configs, truth entries, run records, scores"
```

---

## Task 3: Config loader

**Files:**
- Create: `scripts/eval/config-loader.ts`
- Test: `scripts/eval/config-loader.test.ts`

Reuses the existing Zod schema from `src/config/schema.ts` so we don't drift.

- [ ] **Step 1: Write the failing test**

Create `scripts/eval/config-loader.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPipelineConfig } from './config-loader.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-config-test-'));
}

describe('loadPipelineConfig', () => {
  it('loads a full config and merges with DEFAULT_CONFIG', () => {
    const dir = makeTempDir();
    const path = join(dir, 'sonnet-only.yml');
    writeFileSync(
      path,
      [
        'model: claude-sonnet-4-6',
        'max_turns: 40',
        'severity:',
        '  floor: minor',
        '  max_comments_per_file: 5',
        '  max_comments_total: 30',
        'budget:',
        '  max_input_tokens: 500000',
        '  max_output_tokens: 50000',
      ].join('\n'),
    );
    const cfg = loadPipelineConfig(path);
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.max_turns).toBe(40);
    expect(cfg.severity.floor).toBe('minor');
    expect(cfg.budget.max_input_tokens).toBe(500000);
    // Fields not in the partial config come from DEFAULT_CONFIG.
    expect(cfg.review.event).toBe('COMMENT');
    rmSync(dir, { recursive: true });
  });

  it('accepts a minimal config (just model) and fills the rest from defaults', () => {
    const dir = makeTempDir();
    const path = join(dir, 'minimal.yml');
    writeFileSync(path, 'model: claude-haiku-4-5');
    const cfg = loadPipelineConfig(path);
    expect(cfg.model).toBe('claude-haiku-4-5');
    expect(cfg.max_turns).toBe(40); // from DEFAULT_CONFIG
    expect(cfg.severity.floor).toBe('minor');
    rmSync(dir, { recursive: true });
  });

  it('throws a descriptive error on malformed YAML', () => {
    const dir = makeTempDir();
    const path = join(dir, 'bad.yml');
    writeFileSync(path, ': not : valid : yaml :');
    expect(() => loadPipelineConfig(path)).toThrow(/parse|invalid/i);
    rmSync(dir, { recursive: true });
  });

  it('throws a descriptive error on schema violation', () => {
    const dir = makeTempDir();
    const path = join(dir, 'bad-schema.yml');
    writeFileSync(path, 'severity:\n  floor: NOT_A_REAL_SEVERITY');
    expect(() => loadPipelineConfig(path)).toThrow(/floor|enum/i);
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/eval/config-loader.test.ts`
Expected: FAIL — `loadPipelineConfig` is not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/eval/config-loader.ts`:

```ts
/**
 * Load a pipeline config YAML file from disk and produce a fully-resolved
 * ReviewConfig (with all defaults filled in).
 *
 * Reuses the existing Zod partial-merge plumbing in src/config/loader.ts so
 * the schema stays in lockstep with how production `.code-review.yml` files
 * are loaded.
 */
import { readFileSync } from 'node:fs';
import { loadConfigFromString } from '../../src/config/loader.js';
import type { ReviewConfig } from '../../src/config/types.js';

export function loadPipelineConfig(path: string): ReviewConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read pipeline config ${path}: ${(err as Error).message}`,
    );
  }
  try {
    return loadConfigFromString(raw);
  } catch (err) {
    throw new Error(
      `Pipeline config ${path} is invalid: ${(err as Error).message}`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/eval/config-loader.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/config-loader.ts scripts/eval/config-loader.test.ts
git commit -m "feat(eval): config-loader reuses src/config/loader Zod schema"
```

---

## Task 4: Plant template interface

**Files:**
- Create: `scripts/plant/types.ts`

Pure interface declaration. The implementing templates (Tasks 5-7) exercise it via their tests.

- [ ] **Step 1: Create `scripts/plant/types.ts`**

```ts
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/plant/types.ts
git commit -m "feat(plant): PlantTemplate interface"
```

---

## Task 5: aws-access-key plant template

**Files:**
- Create: `scripts/plant/aws-access-key.ts`
- Test: `scripts/plant/aws-access-key.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/plant/aws-access-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { awsAccessKeyTemplate } from './aws-access-key.js';

describe('awsAccessKeyTemplate', () => {
  it('inserts an AWS key literal at the requested line and produces a matching truth', () => {
    const source = ['line1', 'line2', 'line3', 'line4'].join('\n');
    const { mutated, truth } = awsAccessKeyTemplate.apply(source, {
      type: 'secret:aws-access-key',
      file: 'src/config/aws.ts',
      line: 3,
      value: 'AKIAIOSFODNN7EXAMPLE',
    });
    const lines = mutated.split('\n');
    expect(lines[2]).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(lines[2]).toMatch(/^const\s/);
    expect(truth).toEqual({
      file: 'src/config/aws.ts',
      line_range: [3, 3],
      bug_type: 'secret:aws-access-key',
      severity: 'critical',
      category: ['vulnerability', 'security'],
    });
  });

  it('rejects a value that does not look like an AWS access key', () => {
    expect(() =>
      awsAccessKeyTemplate.apply('a\nb\nc', {
        type: 'secret:aws-access-key',
        file: 'x.ts',
        line: 1,
        value: 'not-an-aws-key',
      }),
    ).toThrow(/AKIA/);
  });

  it('rejects a line number outside the file', () => {
    expect(() =>
      awsAccessKeyTemplate.apply('a\nb', {
        type: 'secret:aws-access-key',
        file: 'x.ts',
        line: 99,
        value: 'AKIAIOSFODNN7EXAMPLE',
      }),
    ).toThrow(/line/i);
  });

  it('defaults to AKIAIOSFODNN7EXAMPLE when value is omitted', () => {
    const { mutated } = awsAccessKeyTemplate.apply('a\nb\nc', {
      type: 'secret:aws-access-key',
      file: 'x.ts',
      line: 2,
    });
    expect(mutated).toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/plant/aws-access-key.test.ts`
Expected: FAIL — `awsAccessKeyTemplate` not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/plant/aws-access-key.ts`:

```ts
/**
 * Plant an AWS access key as a top-level `const` declaration at the requested
 * line. Inserts (does not replace) so subsequent line numbers shift by one.
 *
 * Default value is AWS's canonical EXAMPLE marker so GitHub push-protection
 * doesn't flag the planted fixture as a real key.
 */
import type { PlantConfig } from '../eval/types.js';
import type { PlantTemplate } from './types.js';

const DEFAULT_VALUE = 'AKIAIOSFODNN7EXAMPLE';

export const awsAccessKeyTemplate: PlantTemplate = {
  type: 'secret:aws-access-key',
  apply(source, config) {
    const value = typeof config.value === 'string' ? config.value : DEFAULT_VALUE;
    if (!/^AKIA[0-9A-Z]{16}$/.test(value)) {
      throw new Error(
        `aws-access-key value ${JSON.stringify(value)} doesn't look like a real AWS access key id (AKIA + 16 [0-9A-Z])`,
      );
    }
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `aws-access-key: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    const insertion = `const PLANTED_AWS_KEY = "${value}";`;
    // Insert at (line-1) → the new content sits AT `line`.
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    const mutated = [...before, insertion, ...after].join('\n');
    return {
      mutated,
      truth: {
        file: typeof config.file === 'string' ? config.file : '',
        line_range: [line, line] as const,
        bug_type: 'secret:aws-access-key',
        severity: 'critical',
        category: ['vulnerability', 'security'] as const,
      },
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/plant/aws-access-key.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/plant/aws-access-key.ts scripts/plant/aws-access-key.test.ts
git commit -m "feat(plant): aws-access-key template — inserts AKIA literal"
```

---

## Task 6: sql-injection plant template

**Files:**
- Create: `scripts/plant/sql-injection.ts`
- Test: `scripts/plant/sql-injection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/plant/sql-injection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sqlInjectionTemplate } from './sql-injection.js';

describe('sqlInjectionTemplate', () => {
  it('inserts a template-literal SQL query interpolating an unsanitized variable', () => {
    const source = 'export function query(userId: string) {\n  // body\n}\n';
    const { mutated, truth } = sqlInjectionTemplate.apply(source, {
      type: 'sql-injection',
      file: 'src/db.ts',
      line: 2,
      input_var: 'userId',
    });
    const lines = mutated.split('\n');
    expect(lines[1]).toContain('db.query');
    expect(lines[1]).toContain('${userId}');
    expect(lines[1]).toContain('SELECT');
    expect(truth.bug_type).toBe('sql-injection');
    expect(truth.severity).toBe('critical');
    expect(truth.category).toContain('security');
    expect(truth.line_range[0]).toBe(2);
  });

  it('defaults input_var to "input" when omitted', () => {
    const { mutated } = sqlInjectionTemplate.apply('a\nb', {
      type: 'sql-injection',
      file: 'x.ts',
      line: 1,
    });
    expect(mutated).toContain('${input}');
  });

  it('rejects a line outside the file', () => {
    expect(() =>
      sqlInjectionTemplate.apply('a\nb', {
        type: 'sql-injection',
        file: 'x.ts',
        line: 999,
      }),
    ).toThrow(/line/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/plant/sql-injection.test.ts`
Expected: FAIL — template not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/plant/sql-injection.ts`:

```ts
/**
 * Plant a template-literal SQL query with an unsanitized interpolation. Tests
 * the AI's recognition of string-concatenation injection — the secrets and
 * dependency-cve scanners are inert here.
 */
import type { PlantConfig } from '../eval/types.js';
import type { PlantTemplate } from './types.js';

export const sqlInjectionTemplate: PlantTemplate = {
  type: 'sql-injection',
  apply(source, config) {
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `sql-injection: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    const inputVar =
      typeof config.input_var === 'string' ? config.input_var : 'input';
    const insertion =
      `  const result = await db.query(\`SELECT * FROM users WHERE id = \${${inputVar}}\`);`;
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    return {
      mutated: [...before, insertion, ...after].join('\n'),
      truth: {
        file: typeof config.file === 'string' ? config.file : '',
        line_range: [line, line] as const,
        bug_type: 'sql-injection',
        severity: 'critical',
        category: ['security', 'bug'] as const,
      },
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/plant/sql-injection.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/plant/sql-injection.ts scripts/plant/sql-injection.test.ts
git commit -m "feat(plant): sql-injection template — unsanitized template-literal query"
```

---

## Task 7: vuln-dep-npm plant template

**Files:**
- Create: `scripts/plant/vuln-dep-npm.ts`
- Test: `scripts/plant/vuln-dep-npm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/plant/vuln-dep-npm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { vulnDepNpmTemplate } from './vuln-dep-npm.js';

describe('vulnDepNpmTemplate', () => {
  it('inserts a package-lock.json entry for a known-vulnerable npm package', () => {
    const source = [
      '{',
      '  "name": "test",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": { "name": "test", "version": "1.0.0" }',
      '  }',
      '}',
      '',
    ].join('\n');
    const { mutated, truth } = vulnDepNpmTemplate.apply(source, {
      type: 'vuln-dep:npm',
      file: 'package-lock.json',
      package: 'lodash',
      version: '4.17.20',
    });
    const parsed = JSON.parse(mutated);
    expect(parsed.packages['node_modules/lodash']).toEqual({ version: '4.17.20' });
    expect(truth.bug_type).toBe('vuln-dep:npm:lodash@4.17.20');
    expect(truth.severity).toBe('critical');
    expect(truth.category).toContain('vulnerability');
    expect(truth.file).toBe('package-lock.json');
    // line_range points at the "version": line inside the new node_modules/lodash entry.
    expect(truth.line_range[0]).toBeGreaterThan(0);
    expect(truth.line_range[1]).toBeGreaterThanOrEqual(truth.line_range[0]);
  });

  it('rejects a non-package-lock.json file', () => {
    expect(() =>
      vulnDepNpmTemplate.apply('{}', {
        type: 'vuln-dep:npm',
        file: 'src/foo.ts',
        package: 'lodash',
        version: '4.17.20',
      }),
    ).toThrow(/package-lock\.json/);
  });

  it('rejects malformed lockfile JSON', () => {
    expect(() =>
      vulnDepNpmTemplate.apply('{ bad json', {
        type: 'vuln-dep:npm',
        file: 'package-lock.json',
        package: 'lodash',
        version: '4.17.20',
      }),
    ).toThrow(/JSON/i);
  });

  it('rejects missing package or version', () => {
    expect(() =>
      vulnDepNpmTemplate.apply('{"packages": {"": {}}}', {
        type: 'vuln-dep:npm',
        file: 'package-lock.json',
      }),
    ).toThrow(/package.*version/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/plant/vuln-dep-npm.test.ts`
Expected: FAIL — template not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/plant/vuln-dep-npm.ts`:

```ts
/**
 * Plant a vulnerable npm package in a package-lock.json. We JSON-parse,
 * inject a `packages["node_modules/<name>"]` entry with the given version,
 * then re-serialize with 2-space indent. The truth `line_range` is the
 * line of the new entry's `"version":` declaration (matches the
 * dependency-cve scanner's anchor strategy).
 */
import type { PlantConfig } from '../eval/types.js';
import type { PlantTemplate } from './types.js';

interface PackageLockShape {
  packages?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

export const vulnDepNpmTemplate: PlantTemplate = {
  type: 'vuln-dep:npm',
  apply(source, config) {
    if (config.file !== 'package-lock.json' && !String(config.file).endsWith('/package-lock.json')) {
      throw new Error(
        `vuln-dep:npm only applies to package-lock.json, got ${String(config.file)}`,
      );
    }
    const pkg = typeof config.package === 'string' ? config.package : '';
    const ver = typeof config.version === 'string' ? config.version : '';
    if (!pkg || !ver) {
      throw new Error(
        `vuln-dep:npm requires both 'package' and 'version' params`,
      );
    }
    let parsed: PackageLockShape;
    try {
      parsed = JSON.parse(source) as PackageLockShape;
    } catch (err) {
      throw new Error(
        `vuln-dep:npm: lockfile is invalid JSON: ${(err as Error).message}`,
      );
    }
    parsed.packages = parsed.packages ?? {};
    parsed.packages[`node_modules/${pkg}`] = { version: ver };
    const mutated = JSON.stringify(parsed, null, 2) + '\n';

    // Locate the new "version": line. Re-serialization is deterministic
    // because of the 2-space indent we just used; find the FIRST occurrence
    // of the package's entry key and then the "version" line that follows.
    const lines = mutated.split('\n');
    const keyMatch = `"node_modules/${pkg}":`;
    let entryLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(keyMatch)) {
        entryLine = i + 1; // 1-indexed
        break;
      }
    }
    if (entryLine < 0) {
      throw new Error(
        `vuln-dep:npm: failed to locate planted entry for ${pkg}`,
      );
    }
    let versionLine = entryLine;
    for (let i = entryLine; i < lines.length; i++) {
      if (lines[i]!.includes('"version":')) {
        versionLine = i + 1;
        break;
      }
    }
    return {
      mutated,
      truth: {
        file: String(config.file),
        line_range: [versionLine, versionLine] as const,
        bug_type: `vuln-dep:npm:${pkg}@${ver}`,
        severity: 'critical',
        category: ['vulnerability'] as const,
      },
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/plant/vuln-dep-npm.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/plant/vuln-dep-npm.ts scripts/plant/vuln-dep-npm.test.ts
git commit -m "feat(plant): vuln-dep:npm template — injects a vulnerable lockfile entry"
```

---

## Task 8: Plant template registry

**Files:**
- Create: `scripts/plant/registry.ts`
- Test: `scripts/plant/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/plant/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTemplate, listTemplateTypes } from './registry.js';

describe('plant template registry', () => {
  it('returns the aws-access-key template by type', () => {
    const t = getTemplate('secret:aws-access-key');
    expect(t.type).toBe('secret:aws-access-key');
  });

  it('returns the sql-injection template by type', () => {
    expect(getTemplate('sql-injection').type).toBe('sql-injection');
  });

  it('returns the vuln-dep:npm template by type', () => {
    expect(getTemplate('vuln-dep:npm').type).toBe('vuln-dep:npm');
  });

  it('throws when given an unknown type, listing available ones', () => {
    expect(() => getTemplate('not-a-real-plant-type')).toThrow(/secret:aws-access-key/);
    expect(() => getTemplate('not-a-real-plant-type')).toThrow(/not-a-real-plant-type/);
  });

  it('lists exactly the v1 template types', () => {
    expect(listTemplateTypes().sort()).toEqual([
      'secret:aws-access-key',
      'sql-injection',
      'vuln-dep:npm',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/plant/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `scripts/plant/registry.ts`:

```ts
import type { PlantTemplate } from './types.js';
import { awsAccessKeyTemplate } from './aws-access-key.js';
import { sqlInjectionTemplate } from './sql-injection.js';
import { vulnDepNpmTemplate } from './vuln-dep-npm.js';

const TEMPLATES: ReadonlyArray<PlantTemplate> = [
  awsAccessKeyTemplate,
  sqlInjectionTemplate,
  vulnDepNpmTemplate,
];

const BY_TYPE = new Map<string, PlantTemplate>(
  TEMPLATES.map((t) => [t.type, t]),
);

export function getTemplate(type: string): PlantTemplate {
  const t = BY_TYPE.get(type);
  if (t) return t;
  const available = Array.from(BY_TYPE.keys()).sort().join(', ');
  throw new Error(
    `Unknown plant type "${type}". Available: ${available}`,
  );
}

export function listTemplateTypes(): string[] {
  return Array.from(BY_TYPE.keys());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/plant/registry.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/plant/registry.ts scripts/plant/registry.test.ts
git commit -m "feat(plant): registry mapping plant type -> template"
```

---

## Task 9: Plant runner

**Files:**
- Create: `scripts/plant/plant-runner.ts`
- Test: `scripts/plant/plant-runner.test.ts`

Reads a case directory: parses `plants.yml`, reads `before/`, applies plants in order (each plant sees the post-previous state), writes `after/` + `truth.yml`.

- [ ] **Step 1: Write the failing test**

Create `scripts/plant/plant-runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runPlants } from './plant-runner.js';

function makeCase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plant-runner-test-'));
  mkdirSync(join(dir, 'before/src/config'), { recursive: true });
  writeFileSync(
    join(dir, 'before/src/config/aws.ts'),
    'export const config = {\n  // body\n};\n',
  );
  writeFileSync(
    join(dir, 'before/package-lock.json'),
    JSON.stringify({ name: 'test', lockfileVersion: 3, packages: { '': { name: 'test', version: '1.0.0' } } }, null, 2) + '\n',
  );
  return dir;
}

describe('runPlants', () => {
  it('applies plants in order, writes after/ + truth.yml', async () => {
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 2',
        '  - type: vuln-dep:npm',
        '    file: package-lock.json',
        '    package: lodash',
        '    version: "4.17.20"',
      ].join('\n'),
    );

    await runPlants(caseDir);

    expect(existsSync(join(caseDir, 'after'))).toBe(true);
    const mutatedAws = readFileSync(join(caseDir, 'after/src/config/aws.ts'), 'utf-8');
    expect(mutatedAws).toContain('AKIAIOSFODNN7EXAMPLE');
    const mutatedLock = readFileSync(join(caseDir, 'after/package-lock.json'), 'utf-8');
    expect(JSON.parse(mutatedLock).packages['node_modules/lodash']).toEqual({ version: '4.17.20' });

    const truthRaw = readFileSync(join(caseDir, 'truth.yml'), 'utf-8');
    const truth = parseYaml(truthRaw) as { truths: Array<Record<string, unknown>> };
    expect(truth.truths).toHaveLength(2);
    expect(truth.truths[0]!.bug_type).toBe('secret:aws-access-key');
    expect(truth.truths[0]!.plant_id).toBe(0);
    expect(truth.truths[1]!.bug_type).toBe('vuln-dep:npm:lodash@4.17.20');
    expect(truth.truths[1]!.plant_id).toBe(1);

    rmSync(caseDir, { recursive: true });
  });

  it('throws when plants.yml is missing', async () => {
    const caseDir = makeCase();
    await expect(runPlants(caseDir)).rejects.toThrow(/plants\.yml/);
    rmSync(caseDir, { recursive: true });
  });

  it('throws when a plant references a file outside before/', async () => {
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/does-not-exist.ts',
        '    line: 1',
      ].join('\n'),
    );
    await expect(runPlants(caseDir)).rejects.toThrow(/does-not-exist/);
    rmSync(caseDir, { recursive: true });
  });

  it('subsequent plants on the same file see the post-previous state', async () => {
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 1',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 1',
      ].join('\n'),
    );
    await runPlants(caseDir);
    const mutated = readFileSync(join(caseDir, 'after/src/config/aws.ts'), 'utf-8');
    // Both planted keys present; both inserted at line 1, so the file now has
    // TWO PLANTED_AWS_KEY constants.
    const occurrences = mutated.split('AKIAIOSFODNN7EXAMPLE').length - 1;
    expect(occurrences).toBe(2);
    rmSync(caseDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/plant/plant-runner.test.ts`
Expected: FAIL — `runPlants` not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/plant/plant-runner.ts`:

```ts
/**
 * Read a case's `plants.yml`, apply each plant in order against the case's
 * `before/` snapshot, and write `after/` + `truth.yml`.
 *
 * Plants apply in array order. Each plant sees the file as it exists at
 * apply-time (so subsequent plants on the same file see the cumulative
 * mutations). Truth entries are written in the same order with sequential
 * `plant_id`s starting at 0.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTemplate } from './registry.js';
import type { PlantConfig, TruthEntry } from '../eval/types.js';

interface PlantsYaml {
  plants: PlantConfig[];
}

export async function runPlants(caseDir: string): Promise<void> {
  const plantsPath = join(caseDir, 'plants.yml');
  if (!existsSync(plantsPath)) {
    throw new Error(`Case ${caseDir} is missing plants.yml`);
  }
  const yamlRaw = readFileSync(plantsPath, 'utf-8');
  const parsed = parseYaml(yamlRaw) as PlantsYaml | null;
  if (!parsed || !Array.isArray(parsed.plants)) {
    throw new Error(`plants.yml in ${caseDir} has no top-level 'plants:' array`);
  }

  const beforeDir = join(caseDir, 'before');
  const afterDir = join(caseDir, 'after');
  if (!existsSync(beforeDir)) {
    throw new Error(`Case ${caseDir} is missing before/ snapshot`);
  }

  // Copy before/ → after/ as the starting state, then mutate after/ in place.
  copyTree(beforeDir, afterDir);

  const truths: TruthEntry[] = [];
  for (let i = 0; i < parsed.plants.length; i++) {
    const plant = parsed.plants[i]!;
    const filePath = join(afterDir, String(plant.file));
    if (!existsSync(filePath)) {
      throw new Error(
        `Plant #${i} (${plant.type}) references file '${String(plant.file)}' which does not exist in before/`,
      );
    }
    const template = getTemplate(plant.type);
    const source = readFileSync(filePath, 'utf-8');
    const result = template.apply(source, plant);
    writeFileSync(filePath, result.mutated);
    truths.push({ ...result.truth, plant_id: i });
  }

  writeFileSync(
    join(caseDir, 'truth.yml'),
    stringifyYaml({ truths }),
  );
}

/** Recursive directory copy. Creates dest if missing. Overwrites files. */
function copyTree(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyTree(srcPath, destPath);
    } else if (st.isFile()) {
      const parent = dirname(destPath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      copyFileSync(srcPath, destPath);
    }
    // Ignore symlinks etc. — out of scope for golden cases.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/plant/plant-runner.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/plant/plant-runner.ts scripts/plant/plant-runner.test.ts
git commit -m "feat(plant): plant-runner reads plants.yml, applies in order, writes after/ + truth.yml"
```

---

## Task 10: plant.ts CLI entry

**Files:**
- Create: `scripts/plant.ts`

Pure CLI shim around `runPlants`. No new logic, no separate tests (the runner is tested).

- [ ] **Step 1: Create `scripts/plant.ts`**

```ts
#!/usr/bin/env node
/**
 * CLI: golden:plant --case <id>
 *
 * Reads $GOLDEN_REPO_PATH (or --golden-repo flag) and a case id, runs the
 * plant pipeline for that case.
 */
import { runPlants } from './plant/plant-runner.js';
import { join } from 'node:path';

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const caseId = arg('--case');
  if (!caseId) {
    console.error('usage: golden:plant --case <id> [--golden-repo <path>]');
    process.exit(2);
  }
  const goldenRepo =
    arg('--golden-repo') ?? process.env.GOLDEN_REPO_PATH;
  if (!goldenRepo) {
    console.error('--golden-repo or GOLDEN_REPO_PATH is required');
    process.exit(2);
  }
  const caseDir = join(goldenRepo, 'cases', caseId);
  await runPlants(caseDir);
  console.log(`Planted case ${caseId} → ${caseDir}/after, ${caseDir}/truth.yml`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

Edit `package.json` — add to the `scripts` block:

```json
"golden:plant": "tsx scripts/plant.ts"
```

The full scripts block should look like:

```json
"scripts": {
  "build": "tsx scripts/build.ts",
  "verify-dist": "tsx scripts/verify-dist.ts",
  "typecheck": "tsc --noEmit",
  "lint": "eslint .",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "test": "vitest run",
  "test:watch": "vitest",
  "record-fixture": "tsx scripts/record-fixture.ts",
  "golden:plant": "tsx scripts/plant.ts"
}
```

- [ ] **Step 3: Smoke test — verify it shows usage when called with no args**

Run: `npm run golden:plant -- 2>&1 | head -3`
Expected: prints `usage: golden:plant --case <id> [--golden-repo <path>]` and exits 2.

- [ ] **Step 4: Commit**

```bash
git add scripts/plant.ts package.json
git commit -m "feat(plant): golden:plant CLI"
```

---

## Task 11: Case loader

**Files:**
- Create: `scripts/eval/case-loader.ts`
- Test: `scripts/eval/case-loader.test.ts`

Reads `<GOLDEN_REPO>/cases/<id>/{after,truth.yml}` and returns a flat structure the eval can consume.

- [ ] **Step 1: Write the failing test**

Create `scripts/eval/case-loader.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCase } from './case-loader.js';

function makeCase(): { dir: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
  const id = 'example';
  const caseDir = join(root, 'cases', id);
  mkdirSync(join(caseDir, 'after/src'), { recursive: true });
  writeFileSync(join(caseDir, 'after/src/auth.ts'), 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
  writeFileSync(
    join(caseDir, 'truth.yml'),
    [
      'truths:',
      '  - file: src/auth.ts',
      '    line_range: [1, 1]',
      '    bug_type: secret:aws-access-key',
      '    severity: critical',
      '    plant_id: 0',
      '    category: [vulnerability, security]',
    ].join('\n'),
  );
  return { dir: root, id };
}

describe('loadCase', () => {
  it('reads after/ files and truth.yml from a case directory', () => {
    const { dir, id } = makeCase();
    const c = loadCase(dir, id);
    expect(c.case_id).toBe('example');
    expect(c.files.find((f) => f.path === 'src/auth.ts')?.content).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(c.truths).toHaveLength(1);
    expect(c.truths[0]!.bug_type).toBe('secret:aws-access-key');
    rmSync(dir, { recursive: true });
  });

  it('throws when the case dir is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
    expect(() => loadCase(root, 'nonexistent')).toThrow(/cases.nonexistent/);
    rmSync(root, { recursive: true });
  });

  it('throws when truth.yml is missing (case not planted yet)', () => {
    const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
    mkdirSync(join(root, 'cases', 'no-truth', 'after'), { recursive: true });
    expect(() => loadCase(root, 'no-truth')).toThrow(/truth\.yml/);
    rmSync(root, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/eval/case-loader.test.ts`
Expected: FAIL — `loadCase` not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/eval/case-loader.ts`:

```ts
/**
 * Read a planted case from disk into an in-memory representation that the
 * orchestrator adapter can feed to runOrchestrator.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TruthEntry } from './types.js';

export interface LoadedFile {
  path: string;     // relative to after/
  content: string;
}

export interface LoadedCase {
  case_id: string;
  files: LoadedFile[];
  truths: TruthEntry[];
}

export function loadCase(goldenRepo: string, caseId: string): LoadedCase {
  const caseDir = join(goldenRepo, 'cases', caseId);
  const afterDir = join(caseDir, 'after');
  if (!existsSync(afterDir)) {
    throw new Error(`Case ${caseId} not found at ${afterDir}`);
  }
  const truthPath = join(caseDir, 'truth.yml');
  if (!existsSync(truthPath)) {
    throw new Error(
      `Case ${caseId} has no truth.yml — has it been planted? Run golden:plant --case ${caseId}`,
    );
  }
  const truthYaml = readFileSync(truthPath, 'utf-8');
  const parsed = parseYaml(truthYaml) as { truths?: TruthEntry[] } | null;
  const truths = parsed?.truths ?? [];

  const files: LoadedFile[] = [];
  walk(afterDir, (path) => {
    files.push({
      path: relative(afterDir, path).replaceAll('\\', '/'),
      content: readFileSync(path, 'utf-8'),
    });
  });

  return { case_id: caseId, files, truths };
}

function walk(dir: string, onFile: (p: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, onFile);
    else if (st.isFile()) onFile(p);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/eval/case-loader.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/case-loader.ts scripts/eval/case-loader.test.ts
git commit -m "feat(eval): case-loader reads after/ + truth.yml into in-memory case"
```

---

## Task 12: Orchestrator adapter

**Files:**
- Create: `scripts/eval/orchestrator-adapter.ts`
- Test: `scripts/eval/orchestrator-adapter.test.ts`

This is the glue between the case representation and the existing `runOrchestrator`. The orchestrator currently expects to fetch a PR via Octokit; the adapter fakes a PR context and routes `pulls.createReview` to a capture array.

This task is the trickiest. It mirrors the mocking layer in `src/orchestrator.test.ts` but exposes it as a reusable harness.

- [ ] **Step 1: Write the failing test**

Create `scripts/eval/orchestrator-adapter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

// IMPORTANT: orchestrator-adapter installs vi.mock at module scope (same
// pattern as src/orchestrator.test.ts). Tests must import it BEFORE the
// orchestrator-adapter itself.
import { evalRun } from './orchestrator-adapter.js';
import type { LoadedCase } from './case-loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

const fakeCase: LoadedCase = {
  case_id: 'unit',
  files: [
    { path: 'src/auth.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
  ],
  truths: [
    {
      file: 'src/auth.ts',
      line_range: [1, 1],
      bug_type: 'secret:aws-access-key',
      severity: 'critical',
      plant_id: 0,
      category: ['vulnerability', 'security'],
    },
  ],
};

describe('evalRun', () => {
  it('invokes the orchestrator with the case content and captures findings + cost', async () => {
    // Script a one-turn agent that immediately posts_summary (so the scanner
    // findings carry the run — no extra agent comments).
    const result = await evalRun({
      case: fakeCase,
      config: DEFAULT_CONFIG,
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'post_summary',
              input: {
                strengths: [],
                assessment: 'comment',
                assessment_reasoning: 'No AI findings in unit test',
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        },
      ],
    });

    // The secrets scanner should pick up the AWS key.
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings.some((f) => f.file_path === 'src/auth.ts')).toBe(true);
    expect(result.cost.turns).toBe(1);
    expect(result.cost.wall_ms).toBeGreaterThan(0);
    expect(result.cost.ended_reason).toBe('summary_posted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/eval/orchestrator-adapter.test.ts`
Expected: FAIL — `evalRun` not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/eval/orchestrator-adapter.ts`:

```ts
/**
 * Drive the existing src/orchestrator.runOrchestrator against a LoadedCase
 * instead of a real GitHub PR.
 *
 * Strategy: vi.mock the @octokit/rest and @anthropic-ai/sdk modules at module
 * scope so the orchestrator's createOctokit + runAgent get controllable stubs.
 * The case's `files[]` are served via the mocked `repos.getContent` and a
 * synthesized unified diff is served via `pulls.get(mediaType:'diff')`.
 *
 * The agent's behavior is scripted via `agentScript` — each turn the mocked
 * `messages.create` pops one response off this queue. Tests pre-fill it to
 * exercise specific paths.
 *
 * CAUTION: this file installs vi.mock at module scope. Importing it in
 * production code would replace those modules globally. Only import from
 * scripts/eval/*.test.ts and scripts/eval.ts (the CLI).
 */
import { vi } from 'vitest';
import type { LoadedCase } from './case-loader.js';
import type { RunRecord } from './types.js';
import type { ReviewConfig } from '../../src/config/types.js';

// Shared mutable state between mocks + test driver.
interface AgentTurnResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use';
}

interface AdapterState {
  agentScript: AgentTurnResponse[];
  caseFiles: Map<string, string>;
  caseDiff: string;
  createReviewCalls: Array<{ args: Record<string, unknown> }>;
  costAccum: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    turns: number;
  };
}

const state: AdapterState = {
  agentScript: [],
  caseFiles: new Map(),
  caseDiff: '',
  createReviewCalls: [],
  costAccum: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    turns: 0,
  },
};

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = {
      create: vi.fn(async () => {
        state.costAccum.turns += 1;
        state.costAccum.input_tokens += 100;
        state.costAccum.output_tokens += 50;
        const next = state.agentScript.shift();
        if (!next) {
          throw new Error('agentScript exhausted — test did not script enough turns');
        }
        return {
          id: 'msg_eval',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: next.content,
          stop_reason: next.stop_reason,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      }),
    };
    constructor(_opts: { apiKey: string }) {}
  }
  return { default: FakeAnthropic };
});

vi.mock('@octokit/rest', () => {
  class FakeOctokit {
    public rest: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
    constructor() {
      this.rest = {
        pulls: {
          get: vi.fn(async (args: { mediaType?: { format?: string } }) => {
            if (args.mediaType?.format === 'diff') {
              return { data: state.caseDiff };
            }
            return {
              data: {
                number: 1,
                title: 'Eval run',
                user: { login: 'eval' },
                draft: false,
                additions: 1,
                deletions: 0,
                head: { sha: 'evalhead' },
                base: { sha: 'evalbase' },
              },
            };
          }),
          listFiles: vi.fn(async () => ({
            data: Array.from(state.caseFiles.keys()).map((path) => ({
              filename: path,
              changes: 1,
              patch: `@@ -0,0 +1,1 @@\n+content`,
            })),
          })),
          createReview: vi.fn(async (args: Record<string, unknown>) => {
            state.createReviewCalls.push({ args });
            return { data: { id: 12345 } };
          }),
          listReviews: vi.fn(async () => ({ data: [] })),
          dismissReview: vi.fn(async () => ({ data: {} })),
        },
        repos: {
          getContent: vi.fn(async (args: { path: string }) => {
            const content = state.caseFiles.get(args.path);
            if (content == null) {
              const err = Object.assign(new Error('Not Found'), { status: 404 });
              throw err;
            }
            return {
              data: {
                type: 'file',
                content: Buffer.from(content, 'utf-8').toString('base64'),
                encoding: 'base64',
              },
            };
          }),
        },
      };
    }
    static plugin() {
      return FakeOctokit;
    }
  }
  return { Octokit: FakeOctokit };
});

// Plugin modules pulled in by createOctokit are no-ops in this context.
vi.mock('@octokit/plugin-retry', () => ({ retry: () => ({}) }));
vi.mock('@octokit/plugin-throttling', () => ({ throttling: () => ({}) }));

// Import runOrchestrator AFTER the mocks above are registered.
import { runOrchestrator } from '../../src/orchestrator.js';

export interface EvalRunInput {
  case: LoadedCase;
  config: ReviewConfig;
  anthropicApiKey: string;
  agentScript: AgentTurnResponse[];
}

export interface EvalRunOutput {
  findings: RunRecord['findings'];
  cost: RunRecord['cost'];
}

export async function evalRun(input: EvalRunInput): Promise<EvalRunOutput> {
  // Reset shared state for this run.
  state.agentScript = [...input.agentScript];
  state.caseFiles = new Map(input.case.files.map((f) => [f.path, f.content]));
  state.caseDiff = synthesizeDiff(input.case);
  state.createReviewCalls = [];
  state.costAccum = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    turns: 0,
  };

  // The orchestrator's loadConfig will look for .code-review.yml at HEAD; we
  // serve a serialized form of the supplied config so the orchestrator picks
  // up exactly what the test asked for. (Re-uses the same loader path as a
  // production run — no special-casing.)
  state.caseFiles.set('.code-review.yml', serializeConfigAsYaml(input.config));

  const wallStart = Date.now();
  let endedReason = 'summary_posted';
  try {
    const out = await runOrchestrator({
      owner: 'eval',
      repo: 'eval',
      pull_number: 1,
      anthropic_api_key: input.anthropicApiKey,
      github_token: 'gh-test',
      config_path: '.code-review.yml',
      dry_run: false,
      workspace_dir: '/tmp/eval',
    });
    endedReason = out.ended;
  } catch (err) {
    endedReason = `error: ${(err as Error).message}`;
  }
  const wall_ms = Date.now() - wallStart;

  const captured = state.createReviewCalls[0]?.args as
    | { comments?: Array<Record<string, unknown>> }
    | undefined;
  const findings: RunRecord['findings'] = (captured?.comments ?? []).map(
    (c) =>
      ({
        severity: c.side ? (c.severity as RunRecord['findings'][number]['severity']) : 'minor',
        file_path: c.path as string,
        line: c.line as number,
        side: (c.side as 'RIGHT' | 'LEFT') ?? 'RIGHT',
        category: 'security' as RunRecord['findings'][number]['category'],
        title: '',
        why_it_matters: '',
        confidence: 'medium',
      }) as RunRecord['findings'][number],
  );

  return {
    findings,
    cost: {
      ...state.costAccum,
      cost_usd: state.costAccum.turns * 0.01, // placeholder; real cost comes from the agent runner when wired
      wall_ms,
      ended_reason: endedReason,
    },
  };
}

function synthesizeDiff(c: LoadedCase): string {
  // Minimal diff that marks every file as added so `reviewable_lines` and
  // `added_lines` include all content. The orchestrator's diff-parser is the
  // source of truth for these structures; we feed it a unified-diff shape it
  // can parse.
  const chunks: string[] = [];
  for (const f of c.files) {
    if (f.path === '.code-review.yml') continue;
    const lineCount = f.content.split('\n').length;
    chunks.push(`diff --git a/${f.path} b/${f.path}`);
    chunks.push('new file mode 100644');
    chunks.push(`--- /dev/null`);
    chunks.push(`+++ b/${f.path}`);
    chunks.push(`@@ -0,0 +1,${lineCount} @@`);
    for (const line of f.content.split('\n')) {
      chunks.push('+' + line);
    }
  }
  return chunks.join('\n') + '\n';
}

function serializeConfigAsYaml(cfg: ReviewConfig): string {
  // Inline minimal serializer — the orchestrator's loader is permissive
  // about missing fields, so we only need to emit `model` + `max_turns` +
  // anything that differs from defaults. For simplicity, dump everything.
  // Avoid pulling in `yaml.stringify` here to keep this file's deps tight.
  const lines: string[] = [];
  lines.push(`model: ${cfg.model}`);
  lines.push(`max_turns: ${cfg.max_turns}`);
  lines.push('severity:');
  lines.push(`  floor: ${cfg.severity.floor}`);
  lines.push(`  max_comments_per_file: ${cfg.severity.max_comments_per_file}`);
  lines.push(`  max_comments_total: ${cfg.severity.max_comments_total}`);
  lines.push('budget:');
  lines.push(`  max_input_tokens: ${cfg.budget.max_input_tokens}`);
  lines.push(`  max_output_tokens: ${cfg.budget.max_output_tokens}`);
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/eval/orchestrator-adapter.test.ts`
Expected: PASS — 1 test passes. (If it fails, check console for which mock isn't matching the orchestrator's actual call shape; reconcile with `src/orchestrator.test.ts` which uses the same pattern.)

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/orchestrator-adapter.ts scripts/eval/orchestrator-adapter.test.ts
git commit -m "feat(eval): orchestrator-adapter invokes runOrchestrator against a synthetic PR"
```

---

## Task 13: Scoring

**Files:**
- Create: `scripts/eval/scoring.ts`
- Test: `scripts/eval/scoring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/eval/scoring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scoreRun } from './scoring.js';
import type { RunRecord, TruthEntry } from './types.js';
import type { PostedComment } from '../../src/types.js';

function finding(over: Partial<PostedComment> = {}): PostedComment {
  return {
    severity: 'critical',
    file_path: 'src/auth.ts',
    line: 1,
    side: 'RIGHT',
    category: 'vulnerability',
    title: 'AWS key',
    why_it_matters: '',
    confidence: 'high',
    ...over,
  };
}

function truth(over: Partial<TruthEntry> = {}): TruthEntry {
  return {
    file: 'src/auth.ts',
    line_range: [1, 1],
    bug_type: 'secret:aws-access-key',
    severity: 'critical',
    plant_id: 0,
    category: ['vulnerability', 'security'],
    ...over,
  };
}

const cost: RunRecord['cost'] = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0.5,
  turns: 1,
  wall_ms: 100,
  ended_reason: 'summary_posted',
};

describe('scoreRun', () => {
  it('matches exact (file, line, compatible category) → TP', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth()],
      findings: [finding()],
      cost,
    });
    expect(result.tp).toBe(1);
    expect(result.fn).toBe(0);
    expect(result.fp).toBe(0);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.unaligned).toEqual([]);
    expect(result.cost_per_tp_usd).toBeCloseTo(0.5);
  });

  it('matches within 3-line slack on the same file + compatible category', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 10] })],
      findings: [finding({ line: 13 })],
      cost,
    });
    expect(result.tp).toBe(1);
  });

  it('misses outside the 3-line slack → FN', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 10] })],
      findings: [finding({ line: 14 })],
      cost,
    });
    expect(result.tp).toBe(0);
    expect(result.fn).toBe(1);
    expect(result.fp).toBe(1);
    expect(result.unaligned).toHaveLength(1);
  });

  it('mismatched category → FN + FP', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ category: ['vulnerability'] })],
      findings: [finding({ category: 'readability' })],
      cost,
    });
    expect(result.tp).toBe(0);
    expect(result.fn).toBe(1);
    expect(result.fp).toBe(1);
  });

  it('different file → FN', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ file: 'src/a.ts' })],
      findings: [finding({ file_path: 'src/b.ts' })],
      cost,
    });
    expect(result.tp).toBe(0);
    expect(result.fn).toBe(1);
    expect(result.fp).toBe(1);
  });

  it('cost_per_tp_usd uses max(TP, 1) so zero-TP runs report finite cost', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth()],
      findings: [],
      cost: { ...cost, cost_usd: 1.0 },
    });
    expect(result.tp).toBe(0);
    expect(result.cost_per_tp_usd).toBe(1.0);
  });

  it('preserves all outcomes for the report renderer', () => {
    const t1 = truth({ plant_id: 0 });
    const t2 = truth({ plant_id: 1, file: 'src/other.ts', line_range: [5, 5] });
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [t1, t2],
      findings: [finding()],
      cost,
    });
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]!.status).toBe('matched');
    expect(result.outcomes[1]!.status).toBe('missed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/eval/scoring.test.ts`
Expected: FAIL — `scoreRun` not defined.

- [ ] **Step 3: Write the implementation**

Create `scripts/eval/scoring.ts`:

```ts
/**
 * Score one run record against a case's truths.
 *
 * Match criteria (a finding F matches truth T when ALL hold):
 *   - F.file_path === T.file
 *   - |F.line - T.line_range[0]| <= 3
 *   - F.category ∈ T.category   (the truth declares the compatible category set)
 *
 * Each truth is matched at most once (greedy first-match). Unmatched findings
 * become FPs ("unaligned"). Unmatched truths become FNs.
 */
import type { PostedComment } from '../../src/types.js';
import type { RunRecord, TruthEntry, ScoreResult, TruthOutcome } from './types.js';

const LINE_SLACK = 3;

export interface ScoreInput {
  case_id: string;
  config_name: string;
  truths: readonly TruthEntry[];
  findings: readonly PostedComment[];
  cost: RunRecord['cost'];
}

export function scoreRun(input: ScoreInput): ScoreResult {
  const matchedFindings = new Set<number>();
  const outcomes: TruthOutcome[] = [];

  for (const truth of input.truths) {
    let matchedIdx = -1;
    for (let i = 0; i < input.findings.length; i++) {
      if (matchedFindings.has(i)) continue;
      const f = input.findings[i]!;
      if (f.file_path !== truth.file) continue;
      if (Math.abs(f.line - truth.line_range[0]) > LINE_SLACK) continue;
      if (!truth.category.includes(f.category)) continue;
      matchedIdx = i;
      break;
    }
    if (matchedIdx >= 0) {
      matchedFindings.add(matchedIdx);
      outcomes.push({ truth, status: 'matched', finding: input.findings[matchedIdx]! });
    } else {
      outcomes.push({ truth, status: 'missed' });
    }
  }

  const tp = outcomes.filter((o) => o.status === 'matched').length;
  const fn = outcomes.length - tp;
  const unaligned = input.findings.filter((_f, i) => !matchedFindings.has(i));
  const fp = unaligned.length;

  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const cost_per_tp_usd = input.cost.cost_usd / Math.max(tp, 1);

  return {
    case_id: input.case_id,
    config_name: input.config_name,
    tp,
    fn,
    fp,
    recall,
    precision,
    f1,
    cost_per_tp_usd,
    outcomes,
    unaligned: [...unaligned],
    cost: input.cost,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/eval/scoring.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/scoring.ts scripts/eval/scoring.test.ts
git commit -m "feat(eval): scoring matches findings to truths with 3-line slack + category compat"
```

---

## Task 14: Report renderer

**Files:**
- Create: `scripts/eval/report.ts`
- Test: `scripts/eval/report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/eval/report.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderSummaryReport } from './report.js';
import type { ScoreResult } from './types.js';

function score(over: Partial<ScoreResult> & { config_name: string }): ScoreResult {
  return {
    case_id: 'demo',
    tp: 1,
    fn: 0,
    fp: 0,
    recall: 1,
    precision: 1,
    f1: 1,
    cost_per_tp_usd: 0.5,
    outcomes: [],
    unaligned: [],
    cost: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost_usd: 0.5,
      turns: 1,
      wall_ms: 100,
      ended_reason: 'summary_posted',
    },
    ...over,
  };
}

describe('renderSummaryReport', () => {
  it('emits a markdown table with one row per case and one column per config', () => {
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only' }),
        score({ config_name: 'haiku-only', cost: { ...score({ config_name: 'x' }).cost, cost_usd: 0.1 } }),
      ],
    });
    expect(md).toContain('# Eval run 2026-05-23T15:42:00Z');
    expect(md).toContain('| Case | Plants | sonnet-only | haiku-only |');
    expect(md).toContain('demo');
    expect(md).toContain('🟢'); // haiku-only is cheaper at same recall → win
  });

  it('flags a recall regression with 🔴', () => {
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only', recall: 1, tp: 2, fn: 0 }),
        score({ config_name: 'haiku-only', recall: 0.5, tp: 1, fn: 1, cost: { ...score({ config_name: 'x' }).cost, cost_usd: 0.1 } }),
      ],
    });
    expect(md).toContain('🔴');
  });

  it('flags a cheaper-but-not-enough as 🟡', () => {
    const baseline = score({ config_name: 'sonnet-only', cost: { ...score({ config_name: 'x' }).cost, cost_usd: 1.0 } });
    const challenger = score({ config_name: 'opus-only', cost: { ...baseline.cost, cost_usd: 0.8 } });
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [baseline, challenger],
    });
    expect(md).toContain('🟡');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/eval/report.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `scripts/eval/report.ts`:

```ts
/**
 * Render a markdown summary comparing each config against a baseline.
 *
 * Win/loss colors (per the design spec, "same recall, lower cost"):
 *   🟢 — recall ≥ baseline AND cost < baseline × 0.75
 *   🟡 — recall ≥ baseline AND cost < baseline
 *   🔴 — recall < baseline
 *   ⚪ — within ±5% on both axes
 */
import type { ScoreResult } from './types.js';

export interface RenderSummaryInput {
  timestamp: string;
  baseline_config: string;
  scores: readonly ScoreResult[];
}

const COST_WIN_RATIO = 0.75;
const INCONCLUSIVE_EPSILON = 0.05;

export function renderSummaryReport(input: RenderSummaryInput): string {
  const cases = unique(input.scores.map((s) => s.case_id));
  const configs = unique(input.scores.map((s) => s.config_name));
  const get = (caseId: string, cfg: string): ScoreResult | undefined =>
    input.scores.find((s) => s.case_id === caseId && s.config_name === cfg);

  const lines: string[] = [];
  lines.push(`# Eval run ${input.timestamp}`);
  lines.push('');
  lines.push(`Baseline: \`${input.baseline_config}\``);
  lines.push('');
  lines.push(`| Case | Plants | ${configs.join(' | ')} |`);
  lines.push(`| --- | --- | ${configs.map(() => '---').join(' | ')} |`);
  for (const caseId of cases) {
    const baseline = get(caseId, input.baseline_config);
    const plants = baseline ? baseline.tp + baseline.fn : 0;
    const row: string[] = [caseId, String(plants)];
    for (const cfg of configs) {
      const s = get(caseId, cfg);
      if (!s) {
        row.push('—');
        continue;
      }
      if (cfg === input.baseline_config) {
        row.push(`R ${pct(s.recall)} / $${s.cost.cost_usd.toFixed(2)} (base)`);
      } else if (!baseline) {
        row.push(`R ${pct(s.recall)} / $${s.cost.cost_usd.toFixed(2)}`);
      } else {
        row.push(formatCell(s, baseline));
      }
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatCell(s: ScoreResult, baseline: ScoreResult): string {
  const recallOK = s.recall >= baseline.recall - INCONCLUSIVE_EPSILON;
  const recallEqual = Math.abs(s.recall - baseline.recall) <= INCONCLUSIVE_EPSILON;
  const costRatio = baseline.cost.cost_usd === 0 ? 1 : s.cost.cost_usd / baseline.cost.cost_usd;
  let icon = '⚪';
  if (!recallOK) icon = '🔴';
  else if (costRatio < COST_WIN_RATIO) icon = '🟢';
  else if (costRatio < 1 - INCONCLUSIVE_EPSILON) icon = '🟡';
  else if (recallEqual && Math.abs(costRatio - 1) <= INCONCLUSIVE_EPSILON) icon = '⚪';
  const recallDelta =
    s.recall >= baseline.recall
      ? `+${pct(s.recall - baseline.recall)}`
      : `-${pct(baseline.recall - s.recall)}`;
  const costPct = Math.round((costRatio - 1) * 100);
  const costStr = costPct > 0 ? `+${costPct}%` : `${costPct}%`;
  return `R ${pct(s.recall)} (${recallDelta}) / $${s.cost.cost_usd.toFixed(2)} (${costStr}) ${icon}`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function unique<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/eval/report.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/report.ts scripts/eval/report.test.ts
git commit -m "feat(eval): summary-report renderer with win/loss color cells"
```

---

## Task 15 (deferred — follow-up plan)

**Skipped in this plan.** A production `golden:eval` CLI that runs the matrix against the real Anthropic API requires a small refactor of `src/orchestrator.ts` to extract a DI-friendly `runOrchestratorCore` (skip GitHub fetch, accept pre-built `prContext`, route `postReview` to a capture handler). The existing test-only adapter (Task 12) uses `vi.mock` at module scope, which only works inside vitest — not suitable for the production CLI.

The follow-up plan should:
1. Extract `runOrchestratorCore(input: { prContext, contextFiles, ignoreList, config, scannerDeps, reviewHandler })` from `runOrchestrator`. Public `runOrchestrator` becomes a thin wrapper that does the GitHub fetches then calls core.
2. Add a `reviewHandler` option (default = call `postReview`; harness = push to capture array).
3. Build a non-mock `runRealEvalOnce(case, config, apiKey)` adapter that calls `runOrchestratorCore` directly.
4. Wire the CLI (`scripts/eval.ts`, `golden:eval` npm script) on top of that.
5. End-to-end test: run a small case against `claude-haiku-4-5` for ~$0.05 and assert the report contains expected colors.

For this MVP plan, stop here — Tasks 1-14 + Task 16 give you all the parts, tested via scripted agents.

---

## Task 16: End-to-end integration test

**Files:**
- Create: `tests/fixtures/golden-repo/cases/demo/before/src/auth.ts`
- Create: `tests/fixtures/golden-repo/cases/demo/before/package-lock.json`
- Create: `tests/fixtures/golden-repo/cases/demo/plants.yml`
- Create: `scripts/eval/end-to-end.test.ts`

Runs the full pipeline: plant a tiny case → load → run against a scripted agent → score → render report.

- [ ] **Step 1: Create the fixture case**

Files:

`tests/fixtures/golden-repo/cases/demo/before/src/auth.ts`:
```ts
export const config = {
  // body
};
```

`tests/fixtures/golden-repo/cases/demo/before/package-lock.json`:
```json
{
  "name": "demo",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "demo", "version": "1.0.0" }
  }
}
```

`tests/fixtures/golden-repo/cases/demo/plants.yml`:
```yaml
plants:
  - type: secret:aws-access-key
    file: src/auth.ts
    line: 2
  - type: vuln-dep:npm
    file: package-lock.json
    package: lodash
    version: "4.17.20"
```

- [ ] **Step 2: Write the integration test**

Create `scripts/eval/end-to-end.test.ts`:

```ts
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, cpSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlants } from '../plant/plant-runner.js';
import { loadCase } from './case-loader.js';
import { evalRun } from './orchestrator-adapter.js';
import { scoreRun } from './scoring.js';
import { renderSummaryReport } from './report.js';
import { loadPipelineConfig } from './config-loader.js';

describe('eval harness end-to-end', () => {
  let goldenRepo: string;
  let cleanup: string;

  beforeAll(async () => {
    cleanup = mkdtempSync(join(tmpdir(), 'eval-e2e-'));
    goldenRepo = cleanup;
    // Copy the fixture case in.
    cpSync(
      join(process.cwd(), 'tests/fixtures/golden-repo/cases'),
      join(goldenRepo, 'cases'),
      { recursive: true },
    );
    await runPlants(join(goldenRepo, 'cases/demo'));
  });

  it('plants the case, runs orchestrator, scores, and renders a report', async () => {
    const c = loadCase(goldenRepo, 'demo');
    expect(c.truths).toHaveLength(2);
    expect(c.truths[0]!.bug_type).toBe('secret:aws-access-key');
    expect(c.truths[1]!.bug_type).toContain('vuln-dep:npm');

    const cfg = loadPipelineConfig(join(process.cwd(), 'configs/pipeline/haiku-only.yml'));

    const run = await evalRun({
      case: c,
      config: cfg,
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'post_summary',
              input: {
                strengths: [],
                assessment: 'comment',
                assessment_reasoning: 'AI did not post inline comments in this test',
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        },
      ],
    });

    // The scanner runner is the production code path. With the planted AWS
    // key, the secrets scanner should produce a finding. The lockfile CVE
    // requires an OSV call, which we don't stub here; tolerate 0 or 1
    // findings for that and assert at least the secrets one.
    expect(run.findings.length).toBeGreaterThanOrEqual(1);
    expect(run.findings.some((f) => f.file_path === 'src/auth.ts')).toBe(true);

    const score = scoreRun({
      case_id: c.case_id,
      config_name: 'haiku-only',
      truths: c.truths,
      findings: run.findings,
      cost: run.cost,
    });
    expect(score.tp).toBeGreaterThanOrEqual(1);

    const md = renderSummaryReport({
      timestamp: '2026-05-23T00:00:00Z',
      baseline_config: 'haiku-only',
      scores: [score],
    });
    expect(md).toContain('# Eval run');
    expect(md).toContain('demo');
    expect(md).toContain('haiku-only');
  });

  afterAll(() => {
    rmSync(cleanup, { recursive: true });
  });
});
```

NOTE: The `afterAll` import needs to be added to the import line. Update step:

In the import statement, change:
```ts
import { describe, expect, it, beforeAll } from 'vitest';
```
to:
```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run scripts/eval/end-to-end.test.ts`
Expected: PASS. If the secrets scanner finding doesn't materialize, check that the orchestrator adapter's synthesizeDiff is producing reviewable_lines that cover the planted-key line. The diff template uses `@@ -0,0 +1,N @@` which marks every line as added.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/golden-repo/cases/demo scripts/eval/end-to-end.test.ts
git commit -m "test(eval): end-to-end integration — plant → load → run → score → render"
```

---

## Task 17: Verify the full suite passes

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: all tests pass (existing + the new ~30 added by this plan).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Run build (verify the bundle still works after the new scripts)**

Run: `npm run build`
Expected: clean build. The `scripts/` directory is not bundled (it's only for the CLIs), so the bundle size should be unchanged.

- [ ] **Step 5: Final commit (if anything pre-existing needed adjustment)**

If any of Steps 1-4 found issues, fix them and commit. If everything was already clean, no commit needed — the plan is done.

---

## Done

After Task 17, the eval pipeline's parts are all tested in isolation and one end-to-end integration test demonstrates them composing correctly under a scripted agent:

- `npm run golden:plant -- --case <id> --golden-repo <path>` mutates a case (WORKING)
- The plant/load/run/score/render pipeline is verified against scripted agents

**Not delivered by this plan** (follow-up):
- A working `golden:eval` CLI against real Anthropic API — see Task 15's deferred-notes for the design path
- The orchestrator DI refactor that unblocks the above
- More plant templates (github-pat, pem-private-key, path-traversal, eval-user-input, vuln-dep:pypi)
- `--all` flag, corpus aggregation, `golden:promote`

**Definition of done for the user's stated milestone** ("pick 5 cases, run all 3 configs, look at the report"):
1. This plan ships (gives us the harness parts + scripted-agent confidence)
2. Follow-up plan extracts `runOrchestratorCore` and wires the real-API CLI
3. Author 5 cases, run `golden:eval --configs all`, read the report
4. Decide on Phase B (Haiku triage + Sonnet validate) based on the data
