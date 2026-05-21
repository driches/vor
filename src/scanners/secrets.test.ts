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
 * span (unless explicitly overridden by the caller via `over`).
 */
function makeFileWithLines(
  path_: string,
  lines: readonly string[],
  over: Partial<ChangedFile> = {},
): ChangedFile {
  const text = new Map<number, string>();
  for (let i = 0; i < lines.length; i += 1) {
    text.set(i + 1, lines[i]!);
  }
  const defaultRanges: LineRange[] = lines.length > 0 ? [[1, lines.length]] : [];
  return makeChangedFile({
    path: path_,
    head_line_text: text,
    reviewable_lines: defaultRanges,
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
  it('skips a secret on a line outside `reviewable_lines`', async () => {
    const scanner = createSecretsScanner();
    // Line 5 has the secret, but reviewable_lines only covers lines 1..3.
    const file = makeChangedFile({
      path: 'src/leaky.ts',
      head_line_text: new Map([
        [1, 'first'],
        [2, 'second'],
        [3, 'third'],
        [5, `secret = "${PLANTED_AWS_KEY}"`],
      ]),
      reviewable_lines: [[1, 3]],
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

    const generic = result.findings.find(
      (f) => f.rule_id === 'secret:generic-high-entropy',
    );
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

    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [file], config }),
    );

    expect(
      result.findings.find((f) => f.rule_id === 'secret:generic-high-entropy'),
    ).toBeDefined();
  });
});

// -----------------------------------------------------------------
// scan() — multiple findings in the same file
// -----------------------------------------------------------------

describe('createSecretsScanner — multiple findings', () => {
  it('emits a finding per matched line', async () => {
    const scanner = createSecretsScanner();
    // Two different planted AWS keys on separate lines.
    // AWS's canonical-example-style fixtures with EXAMPLE markers so
    // GitHub's push-protection doesn't flag them as real keys.
    const KEY_A = 'AKIAIOSFODNN7EXAMPLA';
    const KEY_B = 'AKIAIOSFODNN7EXAMPLB';
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
});

// -----------------------------------------------------------------
// scan() — ignore-list: straight match
// -----------------------------------------------------------------

describe('createSecretsScanner — ignored finding', () => {
  it('drops findings that match an ignore entry', async () => {
    const file = makeFileWithLines('src/leaky.ts', [`const k = "${PLANTED_AWS_KEY}";`]);
    const ignoreList = makeIgnoreList({ ignored: true, reason: 'test-suppress' });
    const logger = makeLogger();
    const scanner = createSecretsScanner({ logger });

    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [file], ignoreList }),
    );

    expect(result.findings).toEqual([]);
    expect(ignoreList.matches).toHaveBeenCalled();
    expect(logger.notice).not.toHaveBeenCalled();
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

    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [file], ignoreList }),
    );

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
