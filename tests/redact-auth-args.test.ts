import { describe, it, expect, afterEach } from '@jest/globals';
import { redactAuthArgs, buildAuthArgs, executeSvnCommand, createSvnConfig } from '../common/utils';

const SECRET = 'sup3r-s3cret!';

describe('redactAuthArgs', () => {
  it('replaces the value following --password', () => {
    const out = redactAuthArgs(['info', '--password', SECRET, '--non-interactive']);
    expect(out).toEqual(['info', '--password', '***', '--non-interactive']);
    expect(out.join(' ')).not.toContain(SECRET);
  });

  it('keeps --username readable (useful for diagnosis, not a secret)', () => {
    const out = redactAuthArgs(['--username', 'rodrigo.tenorio', '--password', SECRET]);
    expect(out).toContain('rodrigo.tenorio');
    expect(out).not.toContain(SECRET);
  });

  it('does not mutate the array it was given', () => {
    const original = ['--password', SECRET];
    const out = redactAuthArgs(original);
    expect(original).toEqual(['--password', SECRET]); // real argv still intact for spawn
    expect(out).toEqual(['--password', '***']);
  });

  it('tolerates --password as the last element (no value to redact)', () => {
    expect(redactAuthArgs(['info', '--password'])).toEqual(['info', '--password']);
  });

  it('redacts --password-from-stdin too', () => {
    expect(redactAuthArgs(['--password-from-stdin', SECRET])).toEqual([
      '--password-from-stdin',
      '***'
    ]);
  });

  it('redacts every occurrence', () => {
    const out = redactAuthArgs(['--password', SECRET, 'x', '--password', 'other']);
    expect(out).toEqual(['--password', '***', 'x', '--password', '***']);
  });

  it('does not redact a value that merely looks like the flag', () => {
    // '--password' as a *value* (e.g. searching for the literal string) must
    // still shift redaction to the element after it, never before.
    const out = redactAuthArgs(['--password', '--password']);
    expect(out).toEqual(['--password', '***']);
  });

  it('leaves argv without secrets untouched', () => {
    const args = ['list', 'https://example/repo', '--non-interactive'];
    expect(redactAuthArgs(args)).toEqual(args);
  });
});

describe('password never reaches user-visible output', () => {
  const config = createSvnConfig({
    svnPath: 'svn',
    username: 'someone',
    password: SECRET,
    timeout: 15000
  });

  it('buildAuthArgs still passes the real password to svn', () => {
    // The redaction is display-only: auth must keep working.
    expect(buildAuthArgs(config)).toContain(SECRET);
  });

  describe('SVN_USE_AUTH_CACHE', () => {
    const previous = process.env.SVN_USE_AUTH_CACHE;
    afterEach(() => {
      if (previous === undefined) delete process.env.SVN_USE_AUTH_CACHE;
      else process.env.SVN_USE_AUTH_CACHE = previous;
    });

    it('keeps the password on argv by default (no behaviour change)', () => {
      delete process.env.SVN_USE_AUTH_CACHE;
      expect(buildAuthArgs(config)).toContain(SECRET);
    });

    it('omits credentials entirely when enabled', () => {
      process.env.SVN_USE_AUTH_CACHE = 'true';
      const args = buildAuthArgs(config);
      expect(args).not.toContain(SECRET);
      expect(args).not.toContain('--password');
      expect(args).not.toContain('--username');
      expect(args).toContain('--non-interactive');
    });

    it('still passes credentials when the cache is explicitly bypassed', () => {
      // --no-auth-cache exists to recover from E215004; honouring the cache
      // there would defeat the purpose.
      process.env.SVN_USE_AUTH_CACHE = 'true';
      const args = buildAuthArgs(config, { noAuthCache: true });
      expect(args).toContain(SECRET);
      expect(args).toContain('--no-auth-cache');
    });
  });

  it('omits the password from response.command on a FAILING command', async () => {
    // The failure path is the one most easily missed: three separate error
    // messages embed the command string.
    const result = await executeSvnCommand(config, [
      'info',
      'https://invalid.invalid/definitely-not-a-repo'
    ]).catch((err: any) => err);

    const haystack = [
      (result as any)?.command,
      (result as any)?.message,
      (result as any)?.error,
      (result as any)?.stderr
    ]
      .filter(Boolean)
      .join('\n');

    expect(haystack.length).toBeGreaterThan(0);
    expect(haystack).not.toContain(SECRET);
    expect(haystack).toContain('***');
  }, 30000);
});
