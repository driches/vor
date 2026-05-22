/**
 * Tests for the secret-pattern catalog. We assert one planted positive and one
 * obvious negative per high-confidence pattern (the secrets scanner test file
 * covers integration with the Scanner; this file is the pattern-level smoke
 * suite). Also covers the Shannon entropy helper at its corner cases.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_PATTERNS,
  GENERIC_ENTROPY_PATTERNS,
  shannonEntropy,
  type SecretPattern,
} from './secrets-patterns.js';

function findPattern(id: string): SecretPattern {
  const all = [...DEFAULT_SECRET_PATTERNS, ...GENERIC_ENTROPY_PATTERNS];
  const pattern = all.find((p) => p.id === id);
  if (!pattern) throw new Error(`pattern ${id} not found`);
  return pattern;
}

/**
 * Run a fresh regex against `input`. Patterns carry the `g` flag and share
 * `lastIndex` state between calls — recompiling per assertion keeps each
 * test independent.
 */
function matches(p: SecretPattern, input: string): RegExpMatchArray[] {
  const re = new RegExp(p.pattern.source, p.pattern.flags);
  const out: RegExpMatchArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (p.postCheck && !p.postCheck(m[0])) continue;
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex += 1; // safety against zero-width
  }
  return out;
}

describe('shannonEntropy', () => {
  it('returns 0 for an empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('returns 0 for a string of all identical characters', () => {
    expect(shannonEntropy('AAAAAAAAAA')).toBe(0);
  });

  it('returns > 4.5 for a random-looking base64 string', () => {
    // 40-char uniformly mixed string — typical AWS secret-key entropy region.
    const s = 'abcdefghij0123456789+/ABCDEFGHIJklmnopqrst';
    expect(shannonEntropy(s)).toBeGreaterThan(4.5);
  });

  it('returns ~1 bit/char for a 50/50 two-character mix', () => {
    expect(shannonEntropy('ABABABABABAB')).toBeCloseTo(1, 5);
  });
});

// -----------------------------------------------------------------
// High-confidence patterns: one positive + one negative each.
// -----------------------------------------------------------------

describe('DEFAULT_SECRET_PATTERNS', () => {
  const cases: Array<{
    id: string;
    positive: string;
    negative: string;
  }> = [
    {
      id: 'aws-access-key-id',
      positive: 'AKIAIOSFODNN7EXAMPLE',
      negative: 'AKIA-not-an-id',
    },
    {
      id: 'aws-secret-access-key',
      // High-entropy 40-char base64 blob (mixes case/digits/+).
      positive: 'abcdefghij0123456789+/ABCDEFGHIJklmnopqr',
      // 40 As → fails entropy gate even though regex matches.
      negative: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    // Fixtures below use obviously-fake `xxxx...` suffixes so GitHub's
    // push-protection doesn't classify them as live credentials. Each is
    // long enough to satisfy the corresponding regex's length floor.
    {
      id: 'github-pat-classic',
      positive: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'ghp_short',
    },
    {
      id: 'github-pat-oauth',
      positive: 'gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'gho_short',
    },
    {
      id: 'github-pat-user-server',
      positive: 'ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'ghu_short',
    },
    {
      id: 'github-pat-server-server',
      positive: 'ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'ghs_short',
    },
    {
      id: 'github-pat-refresh',
      positive: 'ghr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'ghr_short',
    },
    {
      id: 'github-pat-fine-grained',
      // 82 chars [A-Za-z0-9_] after the prefix — minimum length floor for fine-grained PATs.
      positive:
        'github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'github_pat_too_short',
    },
    {
      id: 'slack-token',
      positive: 'xoxb-xxxxxxxxxx-xxxxxx',
      negative: 'xoxz-not-a-real-token',
    },
    {
      id: 'stripe-live-key',
      positive: 'sk_live_xxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'sk_test_abcdefghij',
    },
    {
      id: 'stripe-restricted-key',
      positive: 'rk_live_xxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'rk_test_abcdefghij',
    },
    {
      id: 'google-api-key',
      // 'AIza' + exactly 35 chars [A-Za-z0-9_-] = 39 chars total.
      positive: 'AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'AIza-too-short',
    },
    {
      id: 'npm-access-token',
      positive: 'npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      negative: 'npm_short',
    },
    {
      id: 'private-key-pem',
      positive: '-----BEGIN RSA PRIVATE KEY-----',
      negative: '-----BEGIN PUBLIC KEY-----',
    },
  ];

  for (const c of cases) {
    it(`${c.id}: positive case matches`, () => {
      const p = findPattern(c.id);
      const hits = matches(p, c.positive);
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });

    it(`${c.id}: negative case rejected`, () => {
      const p = findPattern(c.id);
      const hits = matches(p, c.negative);
      expect(hits).toEqual([]);
    });
  }

  // -----------------------------------------------------------------
  // AWS secret access key — boundary cases.
  //
  // The old `\b(...)\b` pattern failed to match real AWS secrets that ended
  // in `+` or `/` because `\b` looks for a word/non-word transition and `+`
  // and `/` are non-word. The lookaround-based replacement should match these
  // and STILL reject runs longer than 40 chars (which are typically hashes,
  // not credentials).
  // -----------------------------------------------------------------
  describe('aws-secret-access-key — boundary edge cases', () => {
    const p = (): SecretPattern => findPattern('aws-secret-access-key');

    it('matches a 40-char high-entropy string ending in `+`', () => {
      // 39 chars of mixed base64 followed by a `+`. Total = 40. Entropy > 4.5
      // because the prefix is uniformly mixed.
      const value = 'abcdefghij0123456789ABCDEFGHIJklmnopqrs+';
      expect(value).toHaveLength(40);
      const wrapped = `secret = "${value}";`;
      const hits = matches(p(), wrapped);
      expect(hits.length).toBe(1);
      expect(hits[0]![0]).toBe(value);
    });

    it('matches a 40-char high-entropy string ending in `/`', () => {
      const value = 'abcdefghij0123456789ABCDEFGHIJklmnopqrs/';
      expect(value).toHaveLength(40);
      const wrapped = `secret = "${value}";`;
      const hits = matches(p(), wrapped);
      expect(hits.length).toBe(1);
      expect(hits[0]![0]).toBe(value);
    });

    it('does NOT match a 41-char run (substring should not slip through)', () => {
      // 41 chars total — lookarounds reject because the 41st char is itself
      // a key-char, so neither end's lookaround can claim a "boundary".
      const value = 'abcdefghij0123456789ABCDEFGHIJklmnopqrstuv';
      expect(value.length).toBe(42);
      const hits = matches(p(), value);
      expect(hits).toEqual([]);
    });
  });

  it('exports exactly the documented high-confidence ids', () => {
    const ids = DEFAULT_SECRET_PATTERNS.map((p) => p.id);
    expect(ids).toEqual([
      'aws-access-key-id',
      'aws-secret-access-key',
      'github-pat-classic',
      'github-pat-oauth',
      'github-pat-user-server',
      'github-pat-server-server',
      'github-pat-refresh',
      'github-pat-fine-grained',
      'slack-token',
      'stripe-live-key',
      'stripe-restricted-key',
      'google-api-key',
      'npm-access-token',
      'private-key-pem',
    ]);
  });

  it('every default pattern carries the global flag', () => {
    for (const p of DEFAULT_SECRET_PATTERNS) {
      expect(p.pattern.global).toBe(true);
    }
  });
});

describe('GENERIC_ENTROPY_PATTERNS', () => {
  it('generic-high-entropy: matches a high-entropy 40-char blob', () => {
    const p = findPattern('generic-high-entropy');
    const hits = matches(p, 'abcdefghij0123456789ABCDEFGHIJklmnopqrst');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('generic-high-entropy: rejects a low-entropy run', () => {
    const p = findPattern('generic-high-entropy');
    expect(matches(p, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toEqual([]);
  });

  it('generic-high-entropy: confidence is low, severity is important', () => {
    const p = findPattern('generic-high-entropy');
    expect(p.confidence).toBe('low');
    expect(p.severity).toBe('important');
  });
});
