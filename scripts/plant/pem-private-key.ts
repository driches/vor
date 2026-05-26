/**
 * Plant a PEM-formatted private key block as a multi-line string literal.
 * Inserts a 6-line block at the requested line (declaration + 4 PEM marker
 * lines + closing backtick); subsequent line numbers in the same file shift
 * by 6.
 *
 * Truth `line_range` covers the 4 PEM marker lines only (header → footer,
 * `[line+1, line+4]`), excluding the `const` declaration and closing
 * backtick. With ±3 line-slack in scoring.ts, a finding anchored at the
 * BEGIN header and one near the END footer both score as TP.
 *
 * The body is the textbook 64-char-per-line marker `EXAMPLE...EXAMPLE` so
 * push-protection doesn't treat it as a real key.
 */
import type { PlantTemplate } from './types.js';

const PEM_HEADER = '-----BEGIN PRIVATE KEY-----';
const PEM_FOOTER = '-----END PRIVATE KEY-----';
// Two body lines (base64-like fake content, NOT a real key). The scanner
// matches on the header so the body shape is cosmetic.
const PEM_BODY_1 = 'EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEXAMPLE0';
const PEM_BODY_2 = 'EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEXAMPLE1';

export const pemPrivateKeyTemplate: PlantTemplate = {
  type: 'secret:pem-private-key',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`secret:pem-private-key: missing or empty 'file' param in plants.yml entry`);
    }
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `secret:pem-private-key: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    // Render as a single template-literal string assignment so the planted
    // block stays syntactically valid TypeScript even if the surrounding
    // file is a .ts module. Backticks let the newlines through; the PEM
    // markers are the scanner-detected pattern.
    const insertion = [
      'const PLANTED_PRIVATE_KEY = `',
      PEM_HEADER,
      PEM_BODY_1,
      PEM_BODY_2,
      PEM_FOOTER,
      '`;',
    ];
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    const mutated = [...before, ...insertion, ...after].join('\n');
    // The PEM block occupies the 4 lines from header to footer. The opening
    // `const PLANTED_PRIVATE_KEY = \`` declaration is at `line`, then the
    // header at line+1, body at line+2/+3, footer at line+4. Truth covers
    // header→footer (lines line+1 .. line+4).
    return {
      mutated,
      truth: {
        file: config.file,
        line_range: [line + 1, line + 4] as const,
        bug_type: 'secret:pem-private-key',
        severity: 'critical',
        category: ['vulnerability', 'security'] as const,
      },
    };
  },
};
