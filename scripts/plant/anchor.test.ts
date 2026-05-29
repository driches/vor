import { describe, expect, it } from 'vitest';
import { replaceAnchor } from './anchor.js';

describe('replaceAnchor', () => {
  it('swaps a marker line for the replacement and returns the 1-based line', () => {
    const source = ['line1', '// PLANT_ANCHOR: off-by-one-loop', 'line3'].join('\n');
    const { mutated, line } = replaceAnchor(
      source,
      '// PLANT_ANCHOR: off-by-one-loop',
      'for (let i = 0; i <= arr.length; i++) {}',
      'off-by-one-loop',
    );
    expect(line).toBe(2);
    expect(mutated.split('\n')[1]).toBe('for (let i = 0; i <= arr.length; i++) {}');
    // Surrounding context survives untouched.
    expect(mutated.split('\n')[0]).toBe('line1');
    expect(mutated.split('\n')[2]).toBe('line3');
  });

  it('preserves leading whitespace on the marker line', () => {
    // Without indent preservation a replacement at column 0 would break the
    // surrounding block's indentation and the agent would flag THAT as the
    // bug, not the planted one.
    const source = ['function f() {', '  // PLANT_ANCHOR: x', '}'].join('\n');
    const { mutated } = replaceAnchor(source, '// PLANT_ANCHOR: x', 'return null;', 'x');
    expect(mutated.split('\n')[1]).toBe('  return null;');
  });

  it('matches markers regardless of trailing whitespace on the line', () => {
    // Editors and prettier strip trailing whitespace; either form should match.
    const source = ['line1', '// PLANT_ANCHOR: x   ', 'line3'].join('\n');
    const { line } = replaceAnchor(source, '// PLANT_ANCHOR: x', 'planted', 'x');
    expect(line).toBe(2);
  });

  it('throws a clear error when the marker is missing', () => {
    expect(() =>
      replaceAnchor('line1\nline2', '// PLANT_ANCHOR: missing', 'planted', 'missing'),
    ).toThrow(/marker "\/\/ PLANT_ANCHOR: missing" not found/);
  });

  it('throws when the marker appears more than once (ambiguous truth anchor)', () => {
    // Two markers means scoreRun would have to pick one; that's a case-author
    // bug, not a runtime fallback. Fail loud.
    const source = ['line1', '// PLANT_ANCHOR: dup', 'line3', '// PLANT_ANCHOR: dup', 'line5'].join(
      '\n',
    );
    expect(() => replaceAnchor(source, '// PLANT_ANCHOR: dup', 'planted', 'dup')).toThrow(
      /matched 2 lines/,
    );
  });

  it('throws when only multiple trimmed-equivalent markers exist', () => {
    // Marker on line A is `  // PLANT_ANCHOR: x`, marker on line B is
    // `\t// PLANT_ANCHOR: x` — both trim to the same string and would both
    // be ambiguous match targets.
    const source = ['  // PLANT_ANCHOR: x', '\t// PLANT_ANCHOR: x'].join('\n');
    expect(() => replaceAnchor(source, '// PLANT_ANCHOR: x', 'p', 'x')).toThrow(/matched 2 lines/);
  });
});
