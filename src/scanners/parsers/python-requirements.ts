/**
 * Parser for `requirements.txt` (and variants like `requirements-dev.txt`,
 * `requirements-prod.txt`).
 *
 * v1 scope is intentionally narrow: only `==` pins are reported. Range pins
 * (`>=`, `<`, `~=`, `!=`, etc.) are skipped because OSV needs a concrete
 * version to answer the "is this vulnerable?" question reliably. The
 * dependency-cve scanner can revisit this once we have a resolver in the loop.
 *
 * Skipped line shapes:
 *   - `#` comments (and inline `# ...` trailing comments are tolerated)
 *   - `-r other-requirements.txt` (recursive include)
 *   - `--hash=...` and other `--flag` lines
 *   - blank lines / whitespace-only lines
 *   - range pins (`>=`, `<`, `~=`, etc.)
 *   - editable installs (`-e .`, `-e git+...`)
 *
 * Inline markers like `; python_version > "3.7"` and inline hash comments
 * (`--hash=sha256:...`) on a pin line are stripped — the package+version is
 * still captured.
 */
import path from 'node:path';
import type { ChangedFile } from '../../types.js';
import type { LockfileParser, ParsedDependency } from './types.js';

// Tolerate optional pip "extras" suffix on the package name, e.g.
// `Flask[async]==2.3.2` or `requests[security,socks]==2.31.0`. We discard the
// extras intentionally — they don't affect the pinned version, which is all
// OSV needs to resolve vulnerabilities.
const PIN_RE = /^\s*([A-Za-z0-9._-]+)(?:\[[^\]]+\])?\s*==\s*([^\s;#]+)/;

class PythonRequirementsParser implements LockfileParser {
  readonly ecosystem = 'PyPI' as const;

  matches(file: ChangedFile): boolean {
    const base = path.basename(file.path);
    // Accept common variants: requirements.txt, requirements-dev.txt,
    // requirements-prod.txt, requirements_test.txt, etc.
    return base.startsWith('requirements') && base.endsWith('.txt');
  }

  parse(content: string): ParsedDependency[] {
    const lines = content.split(/\r?\n/);
    const out: ParsedDependency[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('#')) continue;
      // Recursive include: `-r other.txt` or `--requirement other.txt`.
      if (trimmed.startsWith('-r') || trimmed.startsWith('--requirement')) continue;
      // Editable installs: `-e .`, `-e git+https://...`.
      if (trimmed.startsWith('-e')) continue;
      // Other pip flag lines (e.g. `--index-url=...`, `--find-links=...`).
      // Note: a pin line can have trailing `--hash=` segments, which the
      // PIN_RE below handles — we only skip lines whose FIRST token is a flag.
      if (trimmed.startsWith('--')) continue;

      const m = raw.match(PIN_RE);
      if (m == null) continue;

      out.push({
        ecosystem: 'PyPI',
        name: m[1]!,
        version: m[2]!,
        line: i + 1,
      });
    }

    return out;
  }
}

export const pythonRequirementsParser: LockfileParser = new PythonRequirementsParser();
