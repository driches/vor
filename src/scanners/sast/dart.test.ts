import { describe, expect, it } from 'vitest';
import { parseDartLine } from './dart.js';

// `parseDartLine` is the most complex bespoke string parsing in the new
// SAST modules: 8-pipe schema, message tails containing `|`, severity
// validation, numeric coercion. A regression here would silently drop
// every dart finding with no test failure visible, so the cases below
// pin the exact contract: well-formed input parses, malformed input
// returns null (rather than throwing), embedded `|` characters in the
// message survive intact.
describe('parseDartLine', () => {
  it('parses a well-formed INFO line', () => {
    const line =
      'INFO|LINT|prefer_const_constructors|lib/foo.dart|42|7|5|Prefer const constructors';
    expect(parseDartLine(line)).toEqual({
      severity: 'INFO',
      type: 'LINT',
      ruleName: 'prefer_const_constructors',
      filePath: 'lib/foo.dart',
      line: 42,
      column: 7,
      length: 5,
      message: 'Prefer const constructors',
    });
  });

  it('parses ERROR / WARNING severities', () => {
    const err = parseDartLine('ERROR|COMPILE_TIME_ERROR|x|lib/a.dart|1|1|1|msg');
    expect(err?.severity).toBe('ERROR');
    const warn = parseDartLine('WARNING|UNUSED|x|lib/a.dart|2|1|1|msg');
    expect(warn?.severity).toBe('WARNING');
  });

  it('rejects unknown severities (header lines, non-finding lines)', () => {
    expect(parseDartLine('Analyzing project...|extra|cols|do|not|match|the|schema')).toBeNull();
    expect(parseDartLine('NOTICE|LINT|x|lib/a.dart|1|1|1|msg')).toBeNull();
  });

  it('returns null for empty and whitespace-only lines', () => {
    expect(parseDartLine('')).toBeNull();
    expect(parseDartLine('   ')).toBeNull();
  });

  it('returns null when the line has fewer than 8 pipe-delimited fields', () => {
    expect(parseDartLine('INFO|LINT|x|lib/a.dart|1|1|1')).toBeNull();
    expect(parseDartLine('INFO|LINT|x')).toBeNull();
  });

  it('returns null when line is not a positive integer', () => {
    expect(parseDartLine('INFO|LINT|x|lib/a.dart|abc|1|1|msg')).toBeNull();
    expect(parseDartLine('INFO|LINT|x|lib/a.dart|0|1|1|msg')).toBeNull();
    expect(parseDartLine('INFO|LINT|x|lib/a.dart|-5|1|1|msg')).toBeNull();
  });

  it('re-joins message tails that themselves contain `|` characters', () => {
    // Dart messages can contain `|` (e.g. shellcheck-style suggestions,
    // type signatures, regex literals). The 8-field split would lose
    // them as silently dropped data; the re-join preserves them.
    const line = 'ERROR|ERROR|some_rule|lib/bar.dart|10|1|3|Message with | pipe | inside';
    expect(parseDartLine(line)?.message).toBe('Message with | pipe | inside');
  });

  it('coerces non-numeric column / length to 0 (defensive, not null)', () => {
    // column and length are reported by Dart but we don't rely on them
    // — `0` is a safe fallback that doesn't mask the finding itself.
    const r = parseDartLine('INFO|LINT|x|lib/a.dart|10|abc|xyz|msg');
    expect(r).not.toBeNull();
    expect(r?.column).toBe(0);
    expect(r?.length).toBe(0);
  });
});
