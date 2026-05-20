import { describe, expect, it, vi } from 'vitest';
import type { FileReader } from '../github/file-reader.js';
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
