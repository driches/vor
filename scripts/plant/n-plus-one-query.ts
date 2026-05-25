/**
 * Plant an N+1 query: a serial `await db.query(...)` inside a `for…of` loop.
 * Each iteration issues a separate DB roundtrip, so a 100-element `items`
 * array becomes 100 sequential calls instead of one batched query.
 *
 * Inserts a 4-line block (`for` open, `await db.query(...)`, assignment,
 * close brace); subsequent line numbers in the same file shift by 4. The
 * truth `line_range` covers only the inner query line (where the actual
 * N+1 lives) so a finding anchored at the loop header or the inner query
 * both score TP via ±3 line-slack overlap.
 *
 * Pattern is self-contained — no `// PLANT_ANCHOR` marker needed because
 * a `for…of` loop with `await` in its body is a recognizable code shape
 * regardless of surrounding context. Insert-based, unlike the semantic
 * templates that need the marker for realism.
 */
import type { PlantTemplate } from './types.js';

export const nPlusOneQueryTemplate: PlantTemplate = {
  type: 'n-plus-one-query',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`n-plus-one-query: missing or empty 'file' param in plants.yml entry`);
    }
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `n-plus-one-query: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    const itemsVar =
      typeof config.items_var === 'string' ? config.items_var : 'items';
    const insertion = [
      `  for (const item of ${itemsVar}) {`,
      `    const row = await db.query('SELECT * FROM rows WHERE id = $1', [item.id]);`,
      `    item.row = row;`,
      `  }`,
    ];
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    const mutated = [...before, ...insertion, ...after].join('\n');
    // Anchor truth at the inner `await db.query(...)` line — that's where
    // the per-iteration round-trip actually happens. With ±3 slack, findings
    // anchored at the loop header (`line`) or the inner assignment (`line+2`)
    // both still overlap.
    return {
      mutated,
      truth: {
        file: config.file,
        line_range: [line + 1, line + 1] as const,
        bug_type: 'n-plus-one-query',
        severity: 'important',
        category: ['performance'] as const,
      },
    };
  },
};
