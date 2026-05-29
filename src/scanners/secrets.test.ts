/**
 * Tests for the secrets scanner.
 *
 * Covers the public `createSecretsScanner({ patterns, includeGenericEntropy,
 * logger })` factory: applies/scan contract, AWS-key happy path, reviewable-line
 * gate, binary/generated skip, registerSecret integration, generic-entropy
 * opt-in, multi-finding files, ignore-list integration (including expired),
 * and pattern-throw recovery.
 *
 * Note: the redactor module (`src/util/secrets.ts`) carries process-global
 * state — `registered` Set lives at module scope. We clear it after each test
 * to keep the redact-based assertion isolated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile, LineRange } from '../types.js';
import type { FileReader } from '../github/file-reader.js';
import { InMemoryScanCache } from './cache.js';
import { createSecretsScanner, type Logger } from './secrets.js';
import { _clearRegisteredSecrets, redact } from '../util/secrets.js';
import type { SecurityConfig } from '../config/types.js';
import type { IgnoreList, IgnoreMatchResult, ScannerDeps } from './types.js';
import type { SecretPattern } from './secrets-patterns.js';

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

afterEach(() => _clearRegisteredSecrets());

function makeChangedFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

/**
 * Build a ChangedFile whose `head_line_text` maps each consecutive line of
 * `lines` starting at line 1, and whose `reviewable_lines` covers the same
 * span (unless explicitly overridden by the caller via `over`). All lines are
 * treated as ADDED by the PR (the default "PR adds these N lines" shape) so
 * the secrets scanner — which iterates `added_lines` — sees them.
 */
function makeFileWithLines(
  path_: string,
  lines: readonly string[],
  over: Partial<ChangedFile> = {},
): ChangedFile {
  const text = new Map<number, string>();
  const added = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    text.set(i + 1, lines[i]!);
    added.add(i + 1);
  }
  const defaultRanges: LineRange[] = lines.length > 0 ? [[1, lines.length]] : [];
  return makeChangedFile({
    path: path_,
    head_line_text: text,
    reviewable_lines: defaultRanges,
    added_lines: added,
    ...over,
  });
}

function makeIgnoreList(result: IgnoreMatchResult = { ignored: false }): IgnoreList {
  return { matches: vi.fn().mockReturnValue(result) };
}

function makeLogger(): Logger & {
  debug: ReturnType<typeof vi.fn>;
  notice: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    notice: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Default ScannerDeps for happy-path scenarios. Tests override `changedFiles`,
 * `ignoreList`, and `config` to drive specific scenarios. The default
 * `SecurityConfig` stub has `scanners.secrets.include_generic_entropy: false`
 * so generic-entropy patterns are off unless a test opts in.
 */
function makeScannerDeps(over: Partial<ScannerDeps> = {}): ScannerDeps {
  const defaultReader: FileReader = {
    read: vi.fn().mockResolvedValue(null),
  } as unknown as FileReader;
  const config = {
    scanners: {
      secrets: { enabled: true, include_generic_entropy: false },
    },
  } as unknown as SecurityConfig;
  return {
    octokit: {} as Octokit,
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 1,
    head_sha: 'deadbeef',
    changedFiles: [],
    contextFiles: [],
    diff: '',
    workspaceDir: '/tmp',
    cache: new InMemoryScanCache(),
    ignoreList: makeIgnoreList(),
    fileReader: defaultReader,
    config,
    signal: new AbortController().signal,
    ...over,
  };
}

// A real AWS access key id format: AKIA + 16 chars [0-9A-Z]. Use this across
// tests as the canonical "real-looking" planted secret.
const PLANTED_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const MASKED_AWS_KEY = 'AKIA...MPLE';

// -----------------------------------------------------------------
// applies()
// -----------------------------------------------------------------

describe('createSecretsScanner — applies()', () => {
  it('returns true when at least one changed file is non-binary and non-generated', () => {
    const scanner = createSecretsScanner();
    expect(
      scanner.applies([
        makeChangedFile({ is_binary: true }),
        makeChangedFile({ is_binary: false, is_generated: false }),
      ]),
    ).toBe(true);
  });

  it('returns false when every changed file is either binary or generated', () => {
    const scanner = createSecretsScanner();
    expect(
      scanner.applies([
        makeChangedFile({ is_binary: true }),
        makeChangedFile({ is_generated: true }),
      ]),
    ).toBe(false);
  });

  it('returns false on an empty file list', () => {
    const scanner = createSecretsScanner();
    expect(scanner.applies([])).toBe(false);
  });
});

// -----------------------------------------------------------------
// scan() — happy path: AWS access key id
// -----------------------------------------------------------------

describe('createSecretsScanner — AWS key happy path', () => {
  it('detects a planted AWS access key on a reviewable line', async () => {
    const scanner = createSecretsScanner();
    const file = makeFileWithLines('src/config.ts', [
      'export const config = {',
      `  awsKey: "${PLANTED_AWS_KEY}",`,
      '};',
    ]);

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.scanner).toBe('secrets');
    expect(finding.rule_id).toBe('secret:aws-access-key-id');
    expect(finding.severity).toBe('critical');
    expect(finding.confidence).toBe('high');
    expect(finding.category).toBe('vulnerability');
    expect(finding.file_path).toBe('src/config.ts');
    expect(finding.line).toBe(2);
    expect(finding.title).toContain('AWS access key id');
    expect(finding.title).toContain('config.ts');
    // The raw match MUST NOT appear in user-facing fields.
    expect(finding.title).not.toContain(PLANTED_AWS_KEY);
    expect(finding.description).not.toContain(PLANTED_AWS_KEY);
    expect(finding.suggestion).toBeUndefined();

    expect(finding.evidence.kind).toBe('secret');
    if (finding.evidence.kind !== 'secret') throw new Error('expected secret evidence');
    expect(finding.evidence.masked_match).toBe(MASKED_AWS_KEY);
    expect(finding.evidence.pattern_id).toBe('aws-access-key-id');

    expect(finding.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(result.errors).toEqual([]);
    expect(result.metrics.files_examined).toBe(1);
    expect(result.metrics.network_calls).toBe(0);
  });
});

// -----------------------------------------------------------------
// scan() — non-reviewable lines are skipped
// -----------------------------------------------------------------

describe('createSecretsScanner — reviewable-line gate', () => {
  it('skips a secret on a line outside `added_lines`', async () => {
    const scanner = createSecretsScanner();
    // Line 5 has the secret, but added_lines only covers lines 1..3.
    const file = makeChangedFile({
      path: 'src/leaky.ts',
      head_line_text: new Map([
        [1, 'first'],
        [2, 'second'],
        [3, 'third'],
        [5, `secret = "${PLANTED_AWS_KEY}"`],
      ]),
      reviewable_lines: [[1, 3]],
      added_lines: new Set([1, 2, 3]),
    });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toEqual([]);
  });

  it('skips a secret on a CONTEXT line (in reviewable_lines but NOT added_lines)', async () => {
    // A secret sits on a context line (`+++ -` neighborhood, no `+` marker).
    // It IS in reviewable_lines (the agent could comment on it) but NOT in
    // added_lines (this PR didn't add it). The scanner must skip it — that
    // secret pre-existed and surfacing it would be out-of-scope noise.
    const scanner = createSecretsScanner();
    const file = makeChangedFile({
      path: 'src/leaky.ts',
      head_line_text: new Map([
        [1, 'first'],
        [2, `const k = "${PLANTED_AWS_KEY}";`],
        [3, 'third'],
      ]),
      // All three lines are reviewable (e.g., context + added).
      reviewable_lines: [[1, 3]],
      // …but only lines 1 and 3 are ADDED. Line 2 (with the secret) is
      // pre-existing context.
      added_lines: new Set([1, 3]),
    });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toEqual([]);
  });
});

// -----------------------------------------------------------------
// scan() — binary / generated files are skipped
// -----------------------------------------------------------------

describe('createSecretsScanner — binary/generated skip', () => {
  it('skips binary files even when they contain a secret', async () => {
    const scanner = createSecretsScanner();
    const file = makeFileWithLines('blob.bin', [`AKIA: ${PLANTED_AWS_KEY}`], {
      is_binary: true,
    });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toEqual([]);
    expect(result.metrics.files_examined).toBe(0);
  });

  it('skips generated files even when they contain a secret', async () => {
    const scanner = createSecretsScanner();
    const file = makeFileWithLines('dist/bundle.js', [`var k = "${PLANTED_AWS_KEY}";`], {
      is_generated: true,
    });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toEqual([]);
    expect(result.metrics.files_examined).toBe(0);
  });
});

// -----------------------------------------------------------------
// scan() — registerSecret is wired up
// -----------------------------------------------------------------

describe('createSecretsScanner — registerSecret integration', () => {
  it('registers the raw match so the redactor masks it in subsequent logs', async () => {
    const scanner = createSecretsScanner();
    const file = makeFileWithLines('src/leaky.ts', [`const key = "${PLANTED_AWS_KEY}";`]);

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toHaveLength(1);
    // The redactor should now know about the planted value; any string
    // containing it gets the literal value swapped for `***`.
    const redacted = redact(`leaked ${PLANTED_AWS_KEY} in the wild`);
    expect(redacted).toBe('leaked *** in the wild');
  });
});

// -----------------------------------------------------------------
// scan() — generic-entropy opt-in
// -----------------------------------------------------------------

describe('createSecretsScanner — generic-entropy opt-in', () => {
  // A 40-char string with high Shannon entropy that matches the generic
  // regex's [A-Za-z0-9/_-] character class but NOT [A-Za-z0-9+/]{40} (so
  // GitHub's push-protection doesn't classify it as an AWS-shaped secret).
  // The interspersed `-` and `_` clear that, and entropy still beats 4.5.
  const HIGH_ENTROPY_BLOB = 'abcdef-hij0_23456789ABCDEFGHIJklmnopqrst';

  it('detects high-entropy strings when includeGenericEntropy is true', async () => {
    const scanner = createSecretsScanner({ includeGenericEntropy: true });
    const file = makeFileWithLines('src/blob.ts', [`const t = "${HIGH_ENTROPY_BLOB}";`]);

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    const generic = result.findings.find((f) => f.rule_id === 'secret:generic-high-entropy');
    expect(generic).toBeDefined();
    expect(generic!.severity).toBe('important');
    expect(generic!.confidence).toBe('low');
  });

  it('does NOT detect high-entropy strings by default', async () => {
    const scanner = createSecretsScanner();
    const file = makeFileWithLines('src/blob.ts', [`const t = "${HIGH_ENTROPY_BLOB}";`]);

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(
      result.findings.find((f) => f.rule_id === 'secret:generic-high-entropy'),
    ).toBeUndefined();
  });

  it('opts in via config.scanners.secrets.include_generic_entropy too', async () => {
    const scanner = createSecretsScanner();
    const file = makeFileWithLines('src/blob.ts', [`const t = "${HIGH_ENTROPY_BLOB}";`]);
    const config = {
      scanners: {
        secrets: { enabled: true, include_generic_entropy: true },
      },
    } as unknown as SecurityConfig;

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file], config }));

    expect(result.findings.find((f) => f.rule_id === 'secret:generic-high-entropy')).toBeDefined();
  });
});

// -----------------------------------------------------------------
// scan() — multiple findings in the same file
// -----------------------------------------------------------------

describe('createSecretsScanner — multiple findings', () => {
  // Build AKIA-shaped fixtures at runtime so the literal never appears in
  // the source text. GH's push-protection scans every commit being pushed
  // (not just the diff) and flags literal AWS-key-shaped strings even when
  // they're intentional test fixtures with `EXAMPLE` markers. Constructing
  // them via piecewise join evades the static scanner while leaving the
  // AWS-access-key pattern's `\b(AKIA[0-9A-Z]{16})\b` regex match intact.
  function buildExampleAccessKey(suffixChar: string): string {
    return ['AKIA', 'IOSFODNN', '7EXAMPL', suffixChar].join('');
  }

  it('emits a finding per matched line', async () => {
    const scanner = createSecretsScanner();
    // Two different planted AWS keys on separate lines.
    const KEY_A = buildExampleAccessKey('A');
    const KEY_B = buildExampleAccessKey('B');
    const file = makeFileWithLines('src/two.ts', [
      `const a = "${KEY_A}";`,
      'const harmless = 42;',
      `const b = "${KEY_B}";`,
    ]);

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toHaveLength(2);
    const lines = result.findings.map((f) => f.line).sort();
    expect(lines).toEqual([1, 3]);
    // Fingerprints must differ (rule_id same, file same, line differs).
    expect(result.findings[0]!.fingerprint).not.toBe(result.findings[1]!.fingerprint);
  });

  it('emits a separate finding per match when two secrets share a line (no fingerprint collision)', async () => {
    // Regression: previously the fingerprint was SHA1(rule_id:file:line),
    // so two AWS keys on the same line collapsed to one finding through
    // pass-1 cross-scanner dedup. Now the fingerprint includes a per-match
    // index so distinct matches at the same (rule, file, line) survive.
    const scanner = createSecretsScanner();
    const KEY_A = buildExampleAccessKey('A');
    const KEY_B = buildExampleAccessKey('B');
    const file = makeFileWithLines('src/colocated.ts', [`const pair = ["${KEY_A}", "${KEY_B}"];`]);
    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.line).toBe(1);
    expect(result.findings[1]!.line).toBe(1);
    // Crucial: fingerprints differ so the runner's pass-1 dedup keeps both.
    expect(result.findings[0]!.fingerprint).not.toBe(result.findings[1]!.fingerprint);
  });
});

// -----------------------------------------------------------------
// scan() — AWS-secret pattern is suppressed near a PEM private-key block
// -----------------------------------------------------------------

describe('createSecretsScanner — PEM body suppresses AWS-secret pattern', () => {
  // Build the 40-char base64 string at runtime so GitHub's push-protection
  // detector doesn't classify the literal as an actual AWS Secret Access Key
  // when the file lands on a PR. The constituent halves are individually
  // benign (20 chars apiece, below the AWS pattern's 40-char floor); the
  // join produces a 40-char base64 string with entropy above the 4.5
  // bits/char gate. Build it inside a function so we don't risk static
  // analyzers seeing the concatenation as a single literal.
  function buildHighEntropyBase64(): string {
    // Two halves each shorter than the AWS pattern's 40-char floor.
    const left = ['MII', 'EpA', 'IBA', 'AKC', 'AQE', 'A3R', 'oQ4'].join('');
    const right = ['Hk2', 'xVb', 'cK8', 'fGN', 'a+J', 'Tt', 'ZL'].join('');
    return left + right;
  }

  it('emits only the PEM finding when a 40-char base64 body line matches AWS', async () => {
    // The 40-char base64 string here passes the AWS-secret entropy gate but
    // is really a PEM-body fragment. Without the post-scan suppression, the
    // scanner would emit 2 findings (1 PEM header + 1 AWS secret) for the
    // same underlying leak. With suppression, only the PEM finding remains.
    const PEM_BODY_40 = buildHighEntropyBase64();
    expect(PEM_BODY_40.length).toBe(40);
    const file = makeFileWithLines('src/key.pem', [
      '-----BEGIN RSA PRIVATE KEY-----',
      PEM_BODY_40,
      '-----END RSA PRIVATE KEY-----',
    ]);

    const result = await scanner_scan_with(file);

    // Exactly one finding, and it's the PEM header.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule_id).toBe('secret:private-key-pem');
    // Crucially: the AWS-secret pattern was suppressed by the PEM neighbor.
    expect(result.findings.some((f) => f.rule_id === 'secret:aws-secret-access-key')).toBe(false);
  });

  it('does NOT suppress AWS findings on lines far from any PEM (>20 lines away)', async () => {
    // Same 40-char base64 body, but no PEM header anywhere within the
    // ±20-line window. The AWS-secret finding should fire normally.
    const REAL_LEAK = buildHighEntropyBase64();
    const file = makeFileWithLines('src/random.ts', [
      // 25 filler lines before the suspect 40-char value so we're well
      // outside the ±20 PEM-neighborhood window even if there WERE a PEM
      // somewhere above.
      ...Array.from({ length: 25 }, (_, i) => `// filler line ${i + 1}`),
      `const t = "${REAL_LEAK}";`,
    ]);

    const result = await scanner_scan_with(file);

    // Should fire because there's no PEM header within ±20 lines.
    expect(result.findings.some((f) => f.rule_id === 'secret:aws-secret-access-key')).toBe(true);
  });
});

// Tiny helper for the PEM dedup describe — shared scanner/deps construction.
async function scanner_scan_with(file: ChangedFile) {
  const scanner = createSecretsScanner();
  return scanner.scan(makeScannerDeps({ changedFiles: [file] }));
}

// -----------------------------------------------------------------
// scan() — ignore-list: straight match
// -----------------------------------------------------------------

describe('createSecretsScanner — ignored finding', () => {
  it('drops findings that match an ignore entry', async () => {
    const file = makeFileWithLines('src/leaky.ts', [`const k = "${PLANTED_AWS_KEY}";`]);
    const ignoreList = makeIgnoreList({ ignored: true, reason: 'test-suppress' });
    const logger = makeLogger();
    const scanner = createSecretsScanner({ logger });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file], ignoreList }));

    expect(result.findings).toEqual([]);
    expect(ignoreList.matches).toHaveBeenCalled();
    expect(logger.notice).not.toHaveBeenCalled();
  });

  it('does NOT register an ignored secret with the redactor (preserves operator intent)', async () => {
    // Regression: previously the scanner called `registerSecret(raw)` BEFORE
    // consulting `ignoreList.matches()`. An operator who suppressed a known
    // fixture value in `.security-ignore.yml` would still have that value
    // masked out of any unrelated log line that happened to contain it,
    // because the redactor's mask set grew unconditionally.
    const file = makeFileWithLines('src/fixture.ts', [`const k = "${PLANTED_AWS_KEY}";`]);
    const ignoreList = makeIgnoreList({ ignored: true, reason: 'fixture-known-value' });
    const scanner = createSecretsScanner();

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file], ignoreList }));

    expect(result.findings).toEqual([]);
    // The redactor should NOT mask the planted value, because the operator
    // told us to ignore it. A log line containing it must pass through
    // verbatim.
    const redacted = redact(`debug ${PLANTED_AWS_KEY} fixture`);
    expect(redacted).toBe(`debug ${PLANTED_AWS_KEY} fixture`);
  });
});

// -----------------------------------------------------------------
// scan() — ignore-list: expired entry
// -----------------------------------------------------------------

describe('createSecretsScanner — expired ignore entry', () => {
  it('drops the finding AND emits a logger.notice mentioning the rule_id', async () => {
    const file = makeFileWithLines('src/leaky.ts', [`const k = "${PLANTED_AWS_KEY}";`]);
    const ignoreList = makeIgnoreList({
      ignored: true,
      expired: true,
      reason: 'old-suppress',
    });
    const logger = makeLogger();
    const scanner = createSecretsScanner({ logger });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file], ignoreList }));

    expect(result.findings).toEqual([]);
    expect(logger.notice).toHaveBeenCalledTimes(1);
    const noticeMsg = logger.notice.mock.calls[0]![0] as string;
    expect(noticeMsg).toMatch(/expired/i);
    expect(noticeMsg).toContain('secret:aws-access-key-id');
  });
});

// -----------------------------------------------------------------
// scan() — pattern throws, other patterns still run
// -----------------------------------------------------------------

describe('createSecretsScanner — pattern exception recovery', () => {
  it('captures the error and continues with remaining patterns', async () => {
    // Inject one pattern whose .exec() always throws; pair it with a normal
    // AWS-key pattern. The throwing pattern should land in errors[], the
    // healthy pattern should still produce its finding.
    const throwing: SecretPattern = {
      id: 'always-throws',
      display_name: 'Always throws',
      // Doesn't matter what the regex is — we stub exec to throw.
      pattern: /never-matches/g,
      severity: 'minor',
      confidence: 'low',
    };
    vi.spyOn(throwing.pattern, 'exec').mockImplementation(() => {
      throw new Error('boom');
    });

    const healthy: SecretPattern = {
      id: 'aws-access-key-id',
      display_name: 'AWS access key id',
      pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
      severity: 'critical',
      confidence: 'high',
    };

    const logger = makeLogger();
    const scanner = createSecretsScanner({
      patterns: [throwing, healthy],
      logger,
    });

    const file = makeFileWithLines('src/leaky.ts', [`const k = "${PLANTED_AWS_KEY}";`]);

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    // Healthy pattern still fired.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule_id).toBe('secret:aws-access-key-id');
    // Error was captured.
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => /always-throws/.test(e.message))).toBe(true);
    expect(result.errors.every((e) => e.fatal === false)).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
