import { describe, it, expect } from '@jest/globals';
import { errorDetail, skippedTargetReason } from '../common/utils';

/**
 * Reaching a path the working copy never fetched is `svn update --parents`, not
 * logic in this repo: svn creates the missing parents itself at depth empty. What
 * DOES need logic is the price of that flag - see skippedTargetReason below.
 */
describe('skippedTargetReason - --parents must not turn a bad path into a success', () => {
  const target = 'C:/SVN/Software/_dev/Modulos/Fiscal/PastaQueNaoExiste/Alvo';

  it('catches the real output that exits 0 while fetching nothing', () => {
    // (!) Captured verbatim from the server, not hand-written: `svn update
    // --parents` on a path absent from the repository exits 0, and svn names the
    // path RELATIVE TO ITS CWD. An earlier version of this test invented an
    // absolute path, passed, and the guard it protects never fired in practice.
    const output = [
      "Skipped 'Software\\_dev\\Modulos\\Fiscal\\PastaQueNaoExiste\\Alvo' -- Has no versioned parent",
      'Summary of conflicts:',
      '  Skipped paths: 1'
    ].join('\n');

    expect(skippedTargetReason(output, target)).toBe('Has no versioned parent');
  });

  it('still matches when svn prints the absolute path (different cwd)', () => {
    const output = "Skipped 'C:\\SVN\\Software\\_dev\\Modulos\\Fiscal\\PastaQueNaoExiste\\Alvo' -- Has no versioned parent";
    expect(skippedTargetReason(output, target)).toBe('Has no versioned parent');
  });

  it('does not match a relative path that merely ends the same way', () => {
    // 'outro/Alvo' shares the last segment with the target and is NOT it.
    const output = "Skipped 'Software\\outro\\Alvo' -- Has no versioned parent";
    expect(skippedTargetReason(output, target)).toBeUndefined();
  });

  it('matches regardless of separator style or case', () => {
    const output = "Skipped 'c:/svn/software/_dev/modulos/fiscal/pastaquenaoexiste/alvo' -- Has no versioned parent";
    expect(skippedTargetReason(output, target)).toBeDefined();
  });

  it('reports a skip with no trailing reason rather than swallowing it', () => {
    const output = "Skipped 'Software\\_dev\\Modulos\\Fiscal\\PastaQueNaoExiste\\Alvo'";
    expect(skippedTargetReason(output, target)).toBe('no reason given by svn');
  });

  it('ignores a skip of some OTHER path - a bulk update may skip and still work', () => {
    const output = [
      "Skipped 'Software\\outra\\coisa' -- Has no versioned parent",
      'A    Software\\_dev\\Modulos\\Fiscal\\PastaQueNaoExiste\\Alvo\\arquivo.sql',
      'Updated to revision 641627.'
    ].join('\n');
    expect(skippedTargetReason(output, target)).toBeUndefined();
  });

  it('says nothing about a successful update', () => {
    const output = "A    Software\\x\\y.sql\nUpdated to revision 641627.";
    expect(skippedTargetReason(output, target)).toBeUndefined();
    expect(skippedTargetReason('', target)).toBeUndefined();
    expect(skippedTargetReason(output, undefined)).toBeUndefined();
  });

  it('handles the "Skipped missing target" wording svn also uses', () => {
    const output = "Skipped missing target 'Software\\_dev\\Modulos\\Fiscal\\PastaQueNaoExiste\\Alvo'";
    expect(skippedTargetReason(output, target)).toBeDefined();
  });
});

describe('errorDetail - keep the line that names the cause', () => {
  it('keeps the tail, where svn puts the E-code', () => {
    // svn prints context first and the reason last; a head-biased excerpt would
    // have shown "Skipped" and hidden E155007 - the exact information that was
    // missing when this had to be diagnosed by hand.
    const stderr = "Skipped 'C:\\SVN\\Software\\x'\nsvn: E155007: None of the targets are working copies";
    expect(errorDetail(stderr)).toContain('E155007');
  });

  it('returns empty for empty stderr so the message does not gain a blank line', () => {
    expect(errorDetail('')).toBe('');
    expect(errorDetail('   \n  ')).toBe('');
  });

  it('caps a flood of lines and keeps the last ones', () => {
    const stderr = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const detail = errorDetail(stderr);
    expect(detail.split('\n')).toHaveLength(5);
    expect(detail).toContain('line 199');
    expect(detail).not.toContain('line 0\n');
  });

  it('caps total length', () => {
    expect(errorDetail('x'.repeat(5000)).length).toBeLessThanOrEqual(600);
  });
});
