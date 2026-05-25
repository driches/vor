/**
 * Shared helper for "replace-anchored" plant templates.
 *
 * Semantic bugs (off-by-one, missing-null-check, etc.) read as nonsense when
 * inserted into unrelated code — the AI agent reasonably flags the insertion
 * as `architecture`/`yagni` noise rather than the planted bug class, polluting
 * the eval's category match. Replace-anchored templates instead swap a marker
 * line for the buggy code, keeping the surrounding context coherent.
 *
 * Contract: a case author places exactly one line in `before/` whose trimmed
 * content equals `// PLANT_ANCHOR: <template-type>` (or `# PLANT_ANCHOR: ...`
 * for Python). The template calls `replaceAnchor()` to swap that line and
 * receives back the 1-based line number where its mutation now sits.
 *
 * The helper enforces:
 *   - Exactly one matching marker (zero or multiple is a case-authoring bug).
 *   - The marker is matched on the trimmed line content so indentation in the
 *     surrounding code doesn't break matching.
 *   - The replacement preserves the marker line's leading whitespace so the
 *     planted code keeps the file's indentation style.
 */

export interface ReplaceAnchorResult {
  /** Source with the marker line swapped for `replacement`. */
  mutated: string;
  /** 1-based line number where `replacement` now lives. */
  line: number;
}

export function replaceAnchor(
  source: string,
  marker: string,
  replacement: string,
  templateType: string,
): ReplaceAnchorResult {
  const lines = source.split('\n');
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === marker) matches.push(i);
  }
  if (matches.length === 0) {
    throw new Error(
      `${templateType}: marker "${marker}" not found in source — ` +
        `add a line that trims to exactly "${marker}" in the before/ snippet`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${templateType}: marker "${marker}" matched ${matches.length} lines ` +
        `(at 1-based lines ${matches.map((i) => i + 1).join(', ')}) — ` +
        `exactly one marker is required so the truth line_range is unambiguous`,
    );
  }
  const idx = matches[0]!;
  const indent = lines[idx]!.match(/^[ \t]*/)?.[0] ?? '';
  const replaced = indent + replacement;
  const mutated = [...lines.slice(0, idx), replaced, ...lines.slice(idx + 1)].join('\n');
  return { mutated, line: idx + 1 };
}
