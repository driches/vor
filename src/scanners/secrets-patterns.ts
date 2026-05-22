/**
 * In-tree regex set for the `secrets` scanner.
 *
 * Two pattern lists are exported:
 *
 *   - {@link DEFAULT_SECRET_PATTERNS} — high-confidence, well-known prefixed
 *     credentials (AWS access keys, GitHub PATs, Stripe keys, Slack tokens,
 *     PEM private keys, etc.). These ship enabled by default because their
 *     false-positive rate is essentially zero: the prefixes (`AKIA`, `ghp_`,
 *     `sk_live_`, …) are vendor-issued, not user-typed.
 *
 *   - {@link GENERIC_ENTROPY_PATTERNS} — broad "any 32+ char high-entropy
 *     blob" patterns. Opt-in only (`security.scanners.secrets.include_generic_entropy`
 *     in config), because they cheerfully flag UUIDs, base64-encoded test
 *     fixtures, minified JS hashes, and so on.
 *
 * Each pattern carries an optional {@link SecretPattern.postCheck} for
 * secondary verification — currently only the entropy-based patterns use it,
 * to reject low-entropy strings that happen to match the regex (e.g. a
 * 40-char run of "AAAA…"). Implementations should never log the raw match.
 */
import type { Confidence, Severity } from '../types.js';

export interface SecretPattern {
  /** Stable id used in the finding's `rule_id` (e.g. `secret:aws-access-key-id`). */
  id: string;
  /** Human-readable label used in titles (e.g. "AWS access key id"). */
  display_name: string;
  /** Regex with the `g` flag. The scanner relies on `lastIndex` advancement
   *  to find multiple matches per line. */
  pattern: RegExp;
  /** Optional secondary verification — return `false` to reject the match. */
  postCheck?: (match: string) => boolean;
  severity: Severity;
  confidence: Confidence;
}

/**
 * Shannon entropy of a string in bits/character. Used by the entropy-based
 * patterns (AWS secret keys, generic high-entropy blobs). 0 for empty input;
 * 0 for all-same-character; ~6 for uniformly random base64.
 *
 * Implementation note: we compute `-Σ p_i * log2(p_i)` over byte-character
 * frequencies. This is the textbook definition. We do NOT normalize against
 * alphabet size because the threshold (4.5 bits/char) is calibrated for the
 * raw value — switching to a normalized score would silently shift the gate.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Entropy floor used by the AWS secret-key and generic high-entropy
 * patterns. 4.5 bits/char is roughly where uniformly-distributed base64
 * strings sit (max ~6); typical English text sits well below (~3.5). Strings
 * matching the regex but coming in under this gate are almost always not
 * secrets — long runs of the same alphabet character, mostly.
 */
const ENTROPY_FLOOR = 4.5;

function entropyPostCheck(match: string): boolean {
  return shannonEntropy(match) >= ENTROPY_FLOOR;
}

export const DEFAULT_SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'aws-access-key-id',
    display_name: 'AWS access key id',
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    // 40-char base64 strings are extremely common in non-secret contexts
    // (hashes, test fixtures), so the entropy check is what makes this
    // tractable. Even with the gate, the precision is mediocre — hence
    // confidence: medium.
    //
    // Boundary note: `\b` is a transition between word `[A-Za-z0-9_]` and
    // non-word characters. With a character class that ADDS `+` and `/`
    // (both non-word), a real AWS secret ending in `+` or `/` would land
    // `\b` on a non-word/non-word transition and miss. We use lookarounds
    // that explicitly assert "no key-character immediately adjacent" so the
    // pattern catches secrets ending in `+` or `/` too — without the chronic
    // false positive of matching inside longer base64 runs.
    id: 'aws-secret-access-key',
    display_name: 'AWS secret access key',
    pattern: /(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/])/g,
    postCheck: entropyPostCheck,
    severity: 'critical',
    confidence: 'medium',
  },
  {
    id: 'github-pat-classic',
    display_name: 'GitHub personal access token (classic)',
    pattern: /\b(ghp_[A-Za-z0-9]{36,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'github-pat-oauth',
    display_name: 'GitHub OAuth token',
    pattern: /\b(gho_[A-Za-z0-9]{36,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'github-pat-user-server',
    display_name: 'GitHub user-to-server token',
    pattern: /\b(ghu_[A-Za-z0-9]{36,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'github-pat-server-server',
    display_name: 'GitHub server-to-server token',
    pattern: /\b(ghs_[A-Za-z0-9]{36,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'github-pat-refresh',
    display_name: 'GitHub refresh token',
    pattern: /\b(ghr_[A-Za-z0-9]{36,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'github-pat-fine-grained',
    display_name: 'GitHub fine-grained personal access token',
    pattern: /\b(github_pat_[A-Za-z0-9_]{82,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'slack-token',
    display_name: 'Slack token',
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'stripe-live-key',
    display_name: 'Stripe live secret key',
    pattern: /\b(sk_live_[A-Za-z0-9]{20,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'stripe-restricted-key',
    display_name: 'Stripe restricted key',
    pattern: /\b(rk_live_[A-Za-z0-9]{20,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'google-api-key',
    display_name: 'Google API key',
    pattern: /\b(AIza[A-Za-z0-9_-]{35})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    id: 'npm-access-token',
    display_name: 'npm access token',
    pattern: /\b(npm_[A-Za-z0-9]{36,})\b/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    // Unbracketed character class — PEM headers cover RSA, OpenSSH, EC, DSA,
    // and PGP private keys. The `\b` boundary is omitted because `-` is a
    // non-word character; the dashes act as their own boundaries. The whole
    // match is wrapped in a capture group so the secrets scanner's
    // `m[1] ?? m[0]` extraction targets the header itself (not undefined).
    id: 'private-key-pem',
    display_name: 'Private key (PEM)',
    pattern: /(-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----)/g,
    severity: 'critical',
    confidence: 'high',
  },
  {
    // A JWT is three base64url-encoded segments separated by dots. Both the
    // header AND payload are JSON objects, so both segments start with `{` —
    // which base64-encodes to the prefix `eyJ`. Requiring `eyJ` on the
    // first TWO segments (not just the first) sharply cuts false positives:
    // random `eyJ`-prefixed blobs followed by arbitrary `.x.y` won't match.
    // Medium confidence: JWTs are not always secrets (bearer tokens may be
    // ephemeral or intended for runtime), but a committed JWT usually IS a
    // leak — especially session tokens or signed credentials.
    id: 'jwt',
    display_name: 'JSON Web Token (JWT)',
    pattern: /\b(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    severity: 'important',
    confidence: 'medium',
  },
];

export const GENERIC_ENTROPY_PATTERNS: readonly SecretPattern[] = [
  {
    // Catch-all for "looks like a secret": 32+ chars of [A-Za-z0-9/_-] with
    // entropy ≥ 4.5 bits/char. False positives include UUIDs (entropy ~3.7
    // → rejected by the gate), some hashes (entropy can be ≥ 4.5), and
    // base64-encoded fixtures. Hence severity: important / confidence: low.
    id: 'generic-high-entropy',
    display_name: 'High-entropy string',
    pattern: /\b([A-Za-z0-9/_-]{32,})\b/g,
    postCheck: entropyPostCheck,
    severity: 'important',
    confidence: 'low',
  },
];
