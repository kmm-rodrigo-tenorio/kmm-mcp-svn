import { validateRevision } from '../common/utils';

describe('validateRevision', () => {
  it('accepts revision numbers', () => {
    expect(validateRevision('645974')).toBe(true);
    expect(validateRevision('1')).toBe(true);
  });

  it('accepts svn keywords, in any case', () => {
    expect(validateRevision('HEAD')).toBe(true);
    expect(validateRevision('head')).toBe(true);
    expect(validateRevision('BASE')).toBe(true);
    expect(validateRevision('COMMITTED')).toBe(true);
    expect(validateRevision('PREV')).toBe(true);
  });

  it('accepts a {DATE} specifier', () => {
    expect(validateRevision('{2026-09-02}')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(validateRevision('  HEAD  ')).toBe(true);
  });

  // The case from Bug-41093: a caller passed a serialized JSON object where a
  // revision belonged, and svn answered `E205000: Syntax error parsing peg
  // revision` — naming the garbage but not the parameter that carried it.
  it('rejects a serialized object', () => {
    expect(validateRevision('{"$":"HEAD"}')).toBe(false);
  });

  it('rejects other malformed input', () => {
    expect(validateRevision('')).toBe(false);
    expect(validateRevision('HEAD~1')).toBe(false);
    expect(validateRevision('645974:645988')).toBe(false); // a range is not a peg revision
    expect(validateRevision('latest')).toBe(false);
  });
});
