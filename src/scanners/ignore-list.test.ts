import { describe, expect, it, vi } from 'vitest';
import type { FileReader } from '../github/file-reader.js';
import { logger } from '../util/logger.js';
import { IgnoreList } from './ignore-list.js';
import type { ScanEvidence, ScanFinding } from './types.js';

/**
 * Build a stub FileReader from a fixed YAML string (or null for "missing").
 * The IgnoreList only calls `read()`; everything else can be omitted.
 */
function stubReader(content: string | null): FileReader {
  return {
    read: vi.fn().mockResolvedValue(content),
  } as unknown as FileReader;
}

const loadArgs = { owner: 'o', repo: 'r', ref: 'sha', path: '.code-review/security-ignore.yml' };

function makeFinding(over: Partial<ScanFinding> & { evidence?: ScanEvidence } = {}): ScanFinding {
  return {
    scanner: 'dependency-cve',
    rule_id: 'osv:default',
    file_path: 'src/foo.ts',
    line: 1,
    severity: 'critical',
    category: 'vulnerability',
    title: 't',
    description: 'd',
    confidence: 'high',
    evidence: over.evidence ?? {
      kind: 'cve',
      osv_id: 'OSV-1',
      ecosystem: 'npm',
      package: 'lodash',
      affected_version: '4.17.20',
    },
    fingerprint: 'fp',
    ...over,
  };
}

describe('IgnoreList.empty', () => {
  it('matches nothing', () => {
    expect(IgnoreList.empty().matches(makeFinding())).toEqual({ ignored: false });
  });
});

describe('IgnoreList.load — GHSA match', () => {
  it('matches finding by ghsa_id and surfaces the reason', async () => {
    const yaml = `
entries:
  - ghsa_id: GHSA-aaaa-bbbb-cccc
    reason: Internal-only service
    expires: 2099-12-31
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-1',
        ghsa_id: 'GHSA-aaaa-bbbb-cccc',
        ecosystem: 'npm',
        package: 'foo',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'Internal-only service',
    });
  });

  it('does not match a different ghsa_id', async () => {
    const yaml = `
entries:
  - ghsa_id: GHSA-aaaa-bbbb-cccc
    reason: x
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-2',
        ghsa_id: 'GHSA-dddd-eeee-ffff',
        ecosystem: 'npm',
        package: 'foo',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });
});

describe('IgnoreList.load — CVE match', () => {
  it('matches finding by cve_id', async () => {
    const yaml = `
entries:
  - cve_id: CVE-2025-12345
    reason: Patch ships next release
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-1',
        cve_id: 'CVE-2025-12345',
        ecosystem: 'npm',
        package: 'foo',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'Patch ships next release',
    });
  });
});

describe('IgnoreList.load — package + semver range', () => {
  it('matches a version inside the range', async () => {
    const yaml = `
entries:
  - package:
      name: lodash
      ecosystem: npm
      version: ">=4.17.20 <4.18.0"
    reason: Vendor pin
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-3',
        ecosystem: 'npm',
        package: 'lodash',
        affected_version: '4.17.20',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'Vendor pin',
    });
  });

  it('does NOT match a version outside the range', async () => {
    const yaml = `
entries:
  - package:
      name: lodash
      ecosystem: npm
      version: ">=4.17.20 <4.18.0"
    reason: Vendor pin
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-4',
        ecosystem: 'npm',
        package: 'lodash',
        affected_version: '4.18.5',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });

  it('does not match a different ecosystem with the same package name', async () => {
    const yaml = `
entries:
  - package:
      name: lodash
      ecosystem: npm
      version: ">=0.0.0"
    reason: x
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-5',
        ecosystem: 'pypi',
        package: 'lodash',
        affected_version: '4.17.20',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });

  it('matches npm packages case-insensitively (registry normalizes case)', async () => {
    // User writes `React` in the YAML; lockfile publishes `react`. Both
    // refer to the same npm package, so the entry MUST suppress the finding.
    const yaml = `
entries:
  - package:
      name: React
      ecosystem: npm
      version: "^16.0.0"
    reason: Case-insensitive npm match
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-React-1',
        ecosystem: 'npm',
        package: 'react',
        affected_version: '16.5.0',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'Case-insensitive npm match',
    });
  });

  it('does NOT normalize case across non-npm/non-PyPI ecosystems', async () => {
    // Maven (or any ecosystem that isn't npm or PyPI) is case-sensitive at
    // the registry. The same `React` entry against a Maven finding for `react`
    // must NOT match — the normalization is scoped to ecosystems where it's
    // semantically correct.
    const yaml = `
entries:
  - package:
      name: React
      ecosystem: Maven
      version: ">=0.0.0"
    reason: Case-sensitive ecosystem
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-React-2',
        ecosystem: 'Maven',
        package: 'react',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });
});

describe('IgnoreList.load — PyPI PEP 440 fallback', () => {
  // Codex P2 on PR #8: PyPI uses PEP 440 (e.g. `2.0rc1`, `1.0.post1`,
  // `2.0a3`) which the `semver` package rejects. Without a fallback, a
  // perfectly-spelled ignore entry for those versions never matches. The
  // v1-minimal fix: after semver fails, fall back to exact-string match
  // when ecosystem === 'PyPI'.

  it('matches a PEP 440 pre-release version (`2.0rc1`) by exact string', async () => {
    const yaml = `
entries:
  - package:
      name: cryptography
      ecosystem: PyPI
      version: "2.0rc1"
    reason: PyPI exact PEP 440 match
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-PY-1',
        ecosystem: 'PyPI',
        package: 'cryptography',
        affected_version: '2.0rc1',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'PyPI exact PEP 440 match',
    });
  });

  it('matches a PEP 440 post-release version (`1.0.post1`) by exact string', async () => {
    const yaml = `
entries:
  - package:
      name: requests
      ecosystem: PyPI
      version: "1.0.post1"
    reason: PyPI post-release pin
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-PY-2',
        ecosystem: 'PyPI',
        package: 'requests',
        affected_version: '1.0.post1',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'PyPI post-release pin',
    });
  });

  it('still uses the semver fast path when the PyPI version IS valid semver', async () => {
    // `1.0.0` is both PEP 440 and semver. The semver range `>=1.0.0` must
    // still match it — the PyPI fallback only kicks in when semver fails.
    const yaml = `
entries:
  - package:
      name: requests
      ecosystem: PyPI
      version: ">=1.0.0"
    reason: PyPI semver fast path
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-PY-3',
        ecosystem: 'PyPI',
        package: 'requests',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'PyPI semver fast path',
    });
  });

  it('does NOT match a semver-style RANGE against a non-semver PEP 440 finding', async () => {
    // PEP 440 ranges aren't supported in v1. `>=1.0.0` against `2.0rc1`:
    // semver rejects `2.0rc1`, falls through; exact-string compares the
    // version `2.0rc1` to the range `>=1.0.0` — those differ → no match.
    const yaml = `
entries:
  - package:
      name: cryptography
      ecosystem: PyPI
      version: ">=1.0.0"
    reason: PyPI range over non-semver version
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-PY-4',
        ecosystem: 'PyPI',
        package: 'cryptography',
        affected_version: '2.0rc1',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });

  it('does NOT apply the exact-match fallback to non-PyPI ecosystems', async () => {
    // npm ignore entry with an invalid-semver version. semver rejects both
    // sides; the fallback is scoped to PyPI; npm ecosystems get nothing.
    const yaml = `
entries:
  - package:
      name: somepkg
      ecosystem: npm
      version: "2.0rc1"
    reason: npm should not exact-match
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-NPM-RC',
        ecosystem: 'npm',
        package: 'somepkg',
        affected_version: '2.0rc1',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });
});

describe('IgnoreList.load — file + rule match', () => {
  it('matches a secrets finding by file_path and rule_id', async () => {
    const yaml = `
entries:
  - file: src/legacy/old.ts
    rule: "secret:aws-access-key"
    reason: Test fixture
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      scanner: 'secrets',
      rule_id: 'secret:aws-access-key',
      file_path: 'src/legacy/old.ts',
      evidence: {
        kind: 'secret',
        masked_match: 'AKIA****',
        pattern_id: 'aws-access-key',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'Test fixture',
    });
  });

  it('does not match the same file with a different rule', async () => {
    const yaml = `
entries:
  - file: src/legacy/old.ts
    rule: "secret:aws-access-key"
    reason: Test fixture
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      scanner: 'secrets',
      rule_id: 'secret:slack-token',
      file_path: 'src/legacy/old.ts',
      evidence: {
        kind: 'secret',
        masked_match: 'xoxb****',
        pattern_id: 'slack-token',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });
});

describe('IgnoreList.load — expired entries', () => {
  it('still matches but flags expired:true', async () => {
    const yaml = `
entries:
  - ghsa_id: GHSA-old-old-old
    reason: Past sell-by date
    expires: 2020-01-01
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-9',
        ghsa_id: 'GHSA-old-old-old',
        ecosystem: 'npm',
        package: 'foo',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: true,
      reason: 'Past sell-by date',
    });
  });
});

describe('IgnoreList.load — union ordering (ghsa_id wins over package:)', () => {
  it('classifies entries with both ghsa_id and package: as GHSA (union priority)', async () => {
    // Both ghsa_id and a `package:` block are present. The package range
    // (>=99.0.0) explicitly does NOT cover the finding's version 1.0.0, so if
    // a future refactor reordered the Zod union to prefer `package:` first the
    // entry would silently stop matching — this test pins the GHSA-first
    // contract documented in ignoreEntrySchema.
    const yaml = `
entries:
  - ghsa_id: GHSA-aaaa-bbbb-cccc
    package:
      name: lodash
      ecosystem: npm
      version: ">=99.0.0"
    reason: GHSA wins over package
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-7',
        ghsa_id: 'GHSA-aaaa-bbbb-cccc',
        ecosystem: 'npm',
        package: 'lodash',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'GHSA wins over package',
    });
  });
});

describe('IgnoreList.load — expires field formats', () => {
  it('accepts RFC3339 datetime in `expires` and still suppresses the finding', async () => {
    // Without the regex widening, `expires: 2099-12-31T23:59:59Z` would fail
    // schema validation, downgrade the entire file to empty, and silently let
    // the finding through. Verify the entry parses, is not expired, and still
    // ignores the finding.
    const yaml = `
entries:
  - ghsa_id: GHSA-rfc-3339-ok
    reason: RFC3339 timestamp from another tool
    expires: "2099-12-31T23:59:59Z"
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-8',
        ghsa_id: 'GHSA-rfc-3339-ok',
        ecosystem: 'npm',
        package: 'foo',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({
      ignored: true,
      expired: false,
      reason: 'RFC3339 timestamp from another tool',
    });
  });

  it('rejects malformed `expires` (e.g. "tomorrow") and degrades to empty with a debuggable warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockResolvedValue();
    const yaml = `
entries:
  - ghsa_id: GHSA-bad-expires
    reason: x
    expires: tomorrow
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    expect(list.matches(makeFinding())).toEqual({ ignored: false });
    // The warn message should call out a validation failure so the user knows
    // their ignore file silently degraded. (Zod's union-mode error doesn't
    // pinpoint the `expires` field — that's a deliberate trade-off documented
    // in ignoreEntrySchema's comment — but the message must still say
    // "validation failed" so the user has a starting point.)
    const messages = warnSpy.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes('validation failed'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('IgnoreList.load — no match', () => {
  it('returns ignored:false when no entry matches', async () => {
    const yaml = `
entries:
  - ghsa_id: GHSA-aaaa-bbbb-cccc
    reason: x
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    const finding = makeFinding({
      evidence: {
        kind: 'cve',
        osv_id: 'OSV-X',
        ecosystem: 'npm',
        package: 'foo',
        affected_version: '1.0.0',
      },
    });
    expect(list.matches(finding)).toEqual({ ignored: false });
  });
});

describe('IgnoreList.load — malformed YAML', () => {
  it('returns empty list on bad YAML without throwing', async () => {
    const list = await IgnoreList.load(stubReader(': bad : yaml :'), loadArgs);
    expect(list.matches(makeFinding())).toEqual({ ignored: false });
  });

  it('returns empty list on schema violation', async () => {
    // Missing required `reason` field on the entry.
    const yaml = `
entries:
  - ghsa_id: GHSA-xxxx
`;
    const list = await IgnoreList.load(stubReader(yaml), loadArgs);
    expect(list.matches(makeFinding())).toEqual({ ignored: false });
  });

  it('returns empty list when YAML parses to a non-object', async () => {
    const list = await IgnoreList.load(stubReader('"just a string"'), loadArgs);
    expect(list.matches(makeFinding())).toEqual({ ignored: false });
  });
});

describe('IgnoreList.load — missing file', () => {
  it('returns empty list when FileReader.read returns null', async () => {
    const list = await IgnoreList.load(stubReader(null), loadArgs);
    expect(list.matches(makeFinding())).toEqual({ ignored: false });
  });

  it('returns empty list when FileReader.read throws', async () => {
    const reader = {
      read: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as FileReader;
    const list = await IgnoreList.load(reader, loadArgs);
    expect(list.matches(makeFinding())).toEqual({ ignored: false });
  });
});
