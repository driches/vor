import { afterEach, describe, expect, it } from 'vitest';
import { _clearRegisteredSecrets, redact, registerSecret } from './secrets.js';

describe('secrets', () => {
  afterEach(() => _clearRegisteredSecrets());

  it('redacts a registered secret', () => {
    registerSecret('sk-ant-1234567890abc');
    expect(redact('My key is sk-ant-1234567890abc end')).toBe('My key is *** end');
  });

  it('does not register secrets shorter than 8 chars', () => {
    registerSecret('short');
    expect(redact('value short here')).toBe('value short here');
  });

  it('ignores empty/null/undefined', () => {
    registerSecret(undefined);
    registerSecret(null);
    registerSecret('');
    expect(redact('nothing to redact')).toBe('nothing to redact');
  });

  it('redacts multiple distinct secrets', () => {
    registerSecret('AAAAAAAA');
    registerSecret('BBBBBBBB');
    expect(redact('AAAAAAAA and BBBBBBBB')).toBe('*** and ***');
  });

  it('redacts secrets containing regex metacharacters safely', () => {
    registerSecret('abc.def+ghi*jkl');
    expect(redact('value abc.def+ghi*jkl x')).toBe('value *** x');
  });

  it('returns original string when no secrets registered', () => {
    expect(redact('hello world')).toBe('hello world');
  });
});
