import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import {
  createSvnConfig,
  normalizePath,
  resolveWorkingCopyPath
} from '../common/utils';
import { SvnService, NETWORK_TIMEOUT_MS } from '../tools/svn-service';

const cfg = () => createSvnConfig({
  workingDirectory: 'C:/SVN',
  url: 'https://svn.example.com/producao',
  username: 'u',
  password: 'p'
});

describe('normalizePath — resolve against the working copy, not the process cwd', () => {
  // The bug: svn is spawned with cwd = config.workingDirectory, but this resolved
  // relative paths against the NODE process cwd, which under Claude Desktop is the
  // app's install folder. A relative path landed outside the working copy and svn
  // answered "not a working copy" — an error that points at the repository instead
  // of at the path.
  it('resolves a relative path under the given base', () => {
    expect(normalizePath('Software/_dev/x.sql', 'C:/SVN'))
      .toBe('C:/SVN/Software/_dev/x.sql');
  });

  it('leaves an absolute path alone regardless of the base', () => {
    expect(normalizePath('C:/other/x.sql', 'C:/SVN')).toBe('C:/other/x.sql');
  });

  it('still works with no base, for callers that have no config', () => {
    // Backwards compatible: this is the old behaviour, kept so existing callers
    // passing absolute paths are unaffected.
    expect(normalizePath('C:/SVN/x.sql')).toBe('C:/SVN/x.sql');
  });
});

describe('resolveWorkingCopyPath — for commands that only work on a working copy', () => {
  it('refuses a repository URL, saying why', () => {
    // `svn status` and `svn delete` are working-copy commands. The old code ran a
    // URL through normalizePath, turning it into a nonsense local path.
    expect(() => resolveWorkingCopyPath('https://svn.example.com/producao/Software', cfg()))
      .toThrow(/repository URL.*working copy/s);
  });

  it('maps a repo-relative path into the working copy', () => {
    expect(resolveWorkingCopyPath('/Software/_dev/Modulos', cfg()))
      .toBe('C:/SVN/Software/_dev/Modulos');
  });

  it('resolves a plain relative path against the working copy', () => {
    expect(resolveWorkingCopyPath('Software/_dev', cfg()))
      .toBe('C:/SVN/Software/_dev');
  });

  it('passes an absolute local path through', () => {
    expect(resolveWorkingCopyPath('C:/SVN/Software', cfg()))
      .toBe('C:/SVN/Software');
  });
});

describe('commit — refuses to sweep the whole working copy', () => {
  const svc = () => new SvnService({ workingDirectory: 'C:/SVN' });

  it('throws when no paths are given', async () => {
    // With no targets svn commits every modified file below cwd, and cwd is the
    // working-copy root — here spanning several unrelated trees. One revision,
    // not recoverable by editing.
    await expect(svc().commit({ message: 'x' }))
      .rejects.toThrow(/without an explicit path list/);
  });

  it('throws when paths is an empty array', async () => {
    await expect(svc().commit({ message: 'x' }, []))
      .rejects.toThrow(/without an explicit path list/);
  });

  it('names the directory that would be swept', async () => {
    await expect(svc().commit({ message: 'x' })).rejects.toThrow(/C:\/SVN/);
  });

  it('still requires a message', async () => {
    await expect(svc().commit({ message: '' } as any, ['a.sql']))
      .rejects.toThrow(/message is required/);
  });
});

describe('the two-step commit contract is enforced at the tool layer', () => {
  const indexSrc = fs.readFileSync(path.join(process.cwd(), 'index.ts'), 'utf8');

  it('svn_commit declares paths as required with at least one entry', () => {
    expect(indexSrc).toMatch(/paths: z\.array\(z\.string\(\)\)\.min\(1\)/);
  });

  it('svn_commit has confirm defaulting to false', () => {
    expect(indexSrc).toMatch(/confirm: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  });

  it('svn_commit returns a preview before confirm is true', () => {
    expect(indexSrc).toMatch(/args\.confirm !== true/);
    expect(indexSrc).toContain('nothing was written');
  });
});

describe('timeout — the network commands get their own default', () => {
  it('is larger than the global default', () => {
    expect(NETWORK_TIMEOUT_MS).toBeGreaterThan(createSvnConfig().timeout!);
  });

  it('checkout and update apply it, and it stays overridable per call', () => {
    const serviceSrc = fs.readFileSync(path.join(process.cwd(), 'tools', 'svn-service.ts'), 'utf8');
    const uses = serviceSrc.match(/timeout: options\.timeout \?\? NETWORK_TIMEOUT_MS/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it('the timeout message points at the fix instead of just reporting the number', () => {
    const utilsSrc = fs.readFileSync(path.join(process.cwd(), 'common', 'utils.ts'), 'utf8');
    expect(utilsSrc).toContain('Command timeout after ${timeoutMs}ms');
    expect(utilsSrc).toContain('pass a larger');
    expect(utilsSrc).toContain('raise SVN_TIMEOUT');
  });
});

describe('delete — the message parameter is gone, not just undocumented', () => {
  it('no longer pushes --message', () => {
    // It only ever meant something for a delete straight against a URL, and that
    // path was unreachable because normalizePath mangled the URL. Offering the
    // parameter implied a working feature.
    const serviceSrc = fs.readFileSync(path.join(process.cwd(), 'tools', 'svn-service.ts'), 'utf8');
    const deleteBody = serviceSrc.slice(serviceSrc.indexOf('async delete('));
    const upToNextMethod = deleteBody.slice(0, deleteBody.indexOf('\n  /**', 10));
    expect(upToNextMethod).not.toContain("'--message'");
  });

  it('is not exposed by the tool schema either', () => {
    const indexSrc = fs.readFileSync(path.join(process.cwd(), 'index.ts'), 'utf8');
    const deleteTool = indexSrc.slice(indexSrc.indexOf('"svn_delete"'));
    const schema = deleteTool.slice(0, deleteTool.indexOf('async (args)'));
    expect(schema).not.toMatch(/message: z\./);
  });

  it('refuses a URL through the service', async () => {
    const svc = new SvnService({ workingDirectory: 'C:/SVN' });
    await expect(svc.delete('https://svn.example.com/producao/Software/x'))
      .rejects.toThrow(/repository URL|working copy/);
  });
});
