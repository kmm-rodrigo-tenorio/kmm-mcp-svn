import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseMergeOutput, parseMergeinfoOutput, countConflictMarkers, validateRevisionOrRange
} from '../common/utils';
import { SvnService } from '../tools/svn-service';
import { registerJob, resetJobs } from '../common/jobs';
import type { SvnInfo, SvnStatus, SvnResponse, SvnLogEntry } from '../common/types';

/*
 * Saidas reais do svn 1.14.5, capturadas na fixture do interno-26_10_08 (repositorio
 * file:// no scratchpad): trunk com 4 revisoes depois da copia dos branches; b1 com
 * trabalho proprio em a.sql, d.txt e propriedade em b.java; b3 com c.txt excluido.
 */
const DRY_RUN_B1 = `--- Merging r2 through r11 into 'branches\\b1':
   C branches\\b1\\d.txt
C    branches\\b1\\a.sql
 C   branches\\b1\\b.java
U    branches\\b1\\c.txt
Summary of conflicts:
  Text conflicts: 1
  Property conflicts: 1
  Tree conflicts: 1`;

const REAL_MERGE_B1 = `--- Merging r2 through r11 into 'branches\\b1':
   C branches\\b1\\d.txt
C    branches\\b1\\a.sql
 C   branches\\b1\\b.java
U    branches\\b1\\c.txt
--- Recording mergeinfo for merge of r2 through r11 into 'branches\\b1':
 U   branches\\b1
Summary of conflicts:
  Text conflicts: 1
  Property conflicts: 1
  Tree conflicts: 1`;

const SPARSE_B3 = `--- Merging r4 through r11 into 'branches\\b3':
U    branches\\b3\\a.sql
 U   branches\\b3\\b.java
Skipped missing target: 'branches\\b3\\c.txt'
--- Merging r4 through r11 into 'branches\\b3':
D    branches\\b3\\d.txt
Summary of conflicts:
  Skipped paths: 1`;

describe('parseMergeOutput — real svn merge output, split by what the person must decide', () => {
  it('separates text, property and tree conflicts by column', () => {
    const r = parseMergeOutput(DRY_RUN_B1);
    expect(r.textConflicts).toEqual(['branches\\b1\\a.sql']);
    expect(r.propConflicts).toEqual(['branches\\b1\\b.java']);
    expect(r.treeConflicts).toEqual(['branches\\b1\\d.txt']);
    expect(r.changed).toEqual([{ action: 'U', path: 'branches\\b1\\c.txt' }]);
    expect(r.ranges).toEqual(["Merging r2 through r11 into 'branches\\b1':"]);
    expect(r.mergeinfo).toEqual([]);
  });

  it('puts the svn:mergeinfo line of a real merge apart from the changed files', () => {
    const r = parseMergeOutput(REAL_MERGE_B1);
    expect(r.mergeinfo).toEqual(['branches\\b1']);
    expect(r.changed.map(c => c.path)).toEqual(['branches\\b1\\c.txt']);
  });

  it('reports what a sparse working copy skipped, and property-only updates', () => {
    const r = parseMergeOutput(SPARSE_B3);
    expect(r.skipped).toEqual([{ path: 'branches\\b3\\c.txt', reason: undefined }]);
    expect(r.changed).toEqual([
      { action: 'U', path: 'branches\\b3\\a.sql' },
      { action: ' U', path: 'branches\\b3\\b.java' },
      { action: 'D', path: 'branches\\b3\\d.txt' }
    ]);
    expect(r.ranges).toHaveLength(2);
  });

  it('reads the skip reason when svn gives one', () => {
    expect(parseMergeOutput("Skipped 'x.sql' -- Node remains in conflict").skipped)
      .toEqual([{ path: 'x.sql', reason: 'Node remains in conflict' }]);
  });

  it('returns empty lists for an empty answer (revision already merged or not touching the source)', () => {
    const r = parseMergeOutput('');
    expect([r.ranges, r.changed, r.textConflicts, r.propConflicts, r.treeConflicts, r.skipped, r.mergeinfo]
      .every(l => l.length === 0)).toBe(true);
  });
});

describe('parseMergeinfoOutput', () => {
  it('reads the revisions svn printed, as numbers', () => {
    expect(parseMergeinfoOutput('r7\nr8\nr9\nr10\n').map(r => r.revision)).toEqual([7, 8, 9, 10]);
  });

  it('flags a non-inheritable revision (r<n>*)', () => {
    expect(parseMergeinfoOutput('r5*\r\nr6')).toEqual([
      { revision: 5, nonInheritable: true },
      { revision: 6, nonInheritable: false }
    ]);
  });

  it('returns nothing for an empty answer', () => {
    expect(parseMergeinfoOutput('')).toEqual([]);
  });
});

describe('countConflictMarkers — byte-level, latin1 and UTF-8 alike', () => {
  it('counts <<<<<<< and >>>>>>> lines in a latin1 CRLF file, ignoring =======', () => {
    const latin1 = Buffer.from(
      'cria\xe7\xe3o\r\n<<<<<<< .working\r\nv := 2;\r\n||||||| .merge-left.r1\r\nv := 1;\r\n=======\r\nv := 3; -- \xe7\xe3\r\n>>>>>>> .merge-right.r11\r\n',
      'latin1'
    );
    expect(countConflictMarkers(latin1)).toEqual({ open: 1, close: 1 });
  });

  it('does not count a separator line that is content', () => {
    expect(countConflictMarkers(Buffer.from('-- =======\n=======\n<<<<<<<<< not a marker\n'))).toEqual({ open: 0, close: 0 });
  });
});

describe('svn_log revision range (AC-7)', () => {
  it.each(['1:HEAD', '645974:645988', '{2026-01-01T10:00}:HEAD', 'head:5'])('accepts %p', (v) => {
    expect(validateRevisionOrRange(v)).toBe(true);
  });

  it.each(['1:', ':5', '{"$":"HEAD"}:HEAD', '1:2:3', 'HEAD~1:5'])('refuses %p', (v) => {
    expect(validateRevisionOrRange(v)).toBe(false);
  });

  it('getLog refuses a bad side of a range before calling svn', async () => {
    const svc = new SvnService({ svnPath: 'svn-that-does-not-exist', workingDirectory: process.cwd() });
    await expect(svc.getLog(undefined, 1, '1:')).rejects.toThrow(/Invalid revision: 1:/);
    await expect(svc.getLog(undefined, 1, '{"$":"HEAD"}:HEAD')).rejects.toThrow(/Invalid revision/);
  });

  it('getLog lets 1:HEAD through to svn', async () => {
    const svc = new SvnService({ svnPath: 'svn-that-does-not-exist', workingDirectory: process.cwd() });
    await expect(svc.getLog(undefined, 1, '1:HEAD')).rejects.not.toThrow(/Invalid revision/);
  });
});

/**
 * Servico com info/status/log falsos: os guards rodam de verdade, so a leitura da WC e
 * substituida. O svn e um .cmd que sai 0 (e responde `r7 r9* r12` ao mergeinfo), entao
 * qualquer comando que chegar ao processo aparece em `command`.
 */
class FakeService extends SvnService {
  info: Partial<SvnInfo> = { nodeKind: 'directory' };
  statuses: SvnStatus[] = [];
  logCalls: string[] = [];
  async getInfo(): Promise<SvnResponse<SvnInfo>> {
    return { success: true, data: this.info as SvnInfo, command: 'fake info', workingDirectory: '' };
  }
  async getStatus(): Promise<SvnResponse<SvnStatus[]>> {
    return { success: true, data: this.statuses, command: 'fake status', workingDirectory: '' };
  }
  async getLog(_p?: string, _l?: number, revision?: string): Promise<SvnResponse<SvnLogEntry[]>> {
    this.logCalls.push(revision!);
    return {
      success: true, command: 'fake log', workingDirectory: '',
      data: [7, 8, 9].map(n => ({ revision: n, author: `a${n}`, date: 'd', message: `msg ${n}\nsegunda linha` }))
    };
  }
}

const win = process.platform === 'win32' ? describe : describe.skip;

win('svn_merge / svn_resolve / svn_mergeinfo guards (AC-1, AC-3, AC-5)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-tools-'));
  const fakeSvn = path.join(dir, 'fake-svn.cmd');
  const wc = path.join(dir, 'wc').replace(/\\/g, '/');
  const URL = 'file:///C:/repo';
  const svc = () => new FakeService({ svnPath: fakeSvn, workingDirectory: wc, url: URL });

  // createSvnConfig cai em SVN_URL/SVN_REPOSITORY_URL quando o servico nasce sem url: o
  // env do MCP nao pode decidir o teste de origem nao-URL.
  const envUrl = { SVN_URL: process.env.SVN_URL, SVN_REPOSITORY_URL: process.env.SVN_REPOSITORY_URL };

  beforeAll(() => {
    delete process.env.SVN_URL;
    delete process.env.SVN_REPOSITORY_URL;
    fs.mkdirSync(wc, { recursive: true });
    fs.writeFileSync(fakeSvn, '@echo off\r\nif "%1"=="mergeinfo" (echo r7& echo r9*& echo r12)\r\nexit /b 0\r\n');
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(envUrl)) if (v !== undefined) process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => resetJobs());

  it('refuses a URL target', async () => {
    await expect(svc().merge('/trunk', 'https://svn.example.com/repo/branches/b1', { dryRun: true }))
      .rejects.toThrow(/repository URL/);
  });

  it('refuses a source that is not a repository line', async () => {
    const s = new FakeService({ svnPath: fakeSvn, workingDirectory: wc });
    await expect(s.merge('/trunk', '/branches/b1')).rejects.toThrow(/source must be a repository URL/);
  });

  it('refuses a target not at depth infinity, naming the depth, before running svn', async () => {
    const s = svc();
    s.info = { nodeKind: 'directory', depth: 'immediates' };
    await expect(s.merge('/trunk', '/branches/b3', { change: 8 }))
      .rejects.toThrow(/nothing was written[\s\S]*depth is 'immediates'/);
  });

  it('treats an absent Depth as infinity (svn info only prints Depth when it is not)', async () => {
    const r = await svc().merge('/trunk', '/branches/b1', { dryRun: true });
    expect(r.data!.blockers).toEqual([]);
  });

  it.each([
    [{ path: 'x.sql', status: 'modified' }],
    [{ path: 'raiz', status: 'normal', props: 'modified' }],
    [{ path: 'd.txt', status: 'normal', treeConflicted: true }]
  ] as Array<[SvnStatus]>)('refuses a dirty working copy: %p', async (entry) => {
    const s = svc();
    s.statuses = [entry, { path: 'novo.tmp', status: 'unversioned' }];
    await expect(s.merge('/trunk', '/branches/b1')).rejects.toThrow(/1 local modification/);
  });

  it('lists the same blockers on the preview instead of refusing it', async () => {
    const s = svc();
    s.statuses = [{ path: 'x.sql', status: 'modified' }];
    const r = await s.merge('/trunk', '/branches/b1', { dryRun: true });
    expect(r.data!.blockers[0]).toMatch(/local modification/);
    expect(r.command).toContain('merge --accept postpone --dry-run');
  });

  it('ignores unversioned files and runs the real merge with postpone, -c and the resolved paths', async () => {
    const s = svc();
    s.statuses = [{ path: 'a.sql.working', status: 'unversioned' }];
    const r = await s.merge('/trunk', '/branches/b2', { change: 8 });
    expect(r.command).toContain(`merge --accept postpone -c 8 ${URL}/trunk ${wc}/branches/b2`);
    expect(r.command).not.toContain('--dry-run');
  });

  it('refuses while a job runs on an overlapping path', async () => {
    registerJob({ command: 'svn update', target: `${wc}/branches`, cwd: wc });
    await expect(svc().merge('/trunk', '/branches/b1', { dryRun: true })).rejects.toThrow(/Another SVN operation/);
  });

  it('passes a revision list as one -c', async () => {
    const r = await svc().merge('/trunk', '/branches/b1', { revisions: '7,9-12', dryRun: true });
    expect(r.command).toContain(`--dry-run -c 7,9-12 ${URL}/trunk`);
  });

  it.each(['', '9-7', '7,', '0', '7;rm', '-c 7'])('refuses a malformed revision list: %p', async (revisions) => {
    await expect(svc().merge('/trunk', '/branches/b1', { revisions, dryRun: true })).rejects.toThrow(/Invalid revisions/);
  });

  it('refuses change and revisions together', async () => {
    await expect(svc().merge('/trunk', '/branches/b1', { change: 7, revisions: '9', dryRun: true }))
      .rejects.toThrow(/not both/);
  });

  it('refuses a change that is not a positive revision', async () => {
    await expect(svc().merge('/trunk', '/branches/b1', { change: 0 })).rejects.toThrow(/Invalid change/);
  });

  it('mergeinfo: total always, at most `limit` listed, log in ONE ranged call', async () => {
    const s = svc();
    const r = await s.mergeinfo('/trunk', '/branches/b1', { limit: 2 });
    expect(r.command).toContain(`mergeinfo --show-revs eligible ${URL}/trunk ${wc}/branches/b1`);
    expect(r.data!.total).toBe(3);
    expect(r.data!.revisions).toEqual([
      { revision: 7, nonInheritable: false, author: 'a7', date: 'd', message: 'msg 7' },
      { revision: 9, nonInheritable: true, author: 'a9', date: 'd', message: 'msg 9' }
    ]);
    expect(s.logCalls).toEqual(['7:9']);
  });

  it('mergeinfo keeps a URL target as URL and skips the log for merged', async () => {
    const s = svc();
    const r = await s.mergeinfo('/trunk', `${URL}/branches/b1`, { show: 'merged' });
    expect(r.command).toContain(`--show-revs merged ${URL}/trunk ${URL}/branches/b1`);
    expect(s.logCalls).toEqual([]);
  });

  describe('resolve', () => {
    const file = `${wc}/branches/b1/a.sql`;
    const conflicted = (extra: Partial<SvnStatus> = {}): SvnStatus[] =>
      [{ path: file.replace(/\//g, '\\'), status: 'conflicted', props: 'none', ...extra }];

    beforeAll(() => fs.mkdirSync(path.dirname(file), { recursive: true }));

    it('reports markers left and refuses to confirm while they remain', async () => {
      fs.writeFileSync(file, Buffer.from('<<<<<<< .working\r\na\r\n=======\r\nb \xe7\r\n>>>>>>> .merge-right.r11\r\n', 'latin1'));
      const s = svc();
      s.statuses = conflicted();
      const preview = await s.resolve('/branches/b1/a.sql', { dryRun: true });
      expect(preview.data!.markers).toEqual({ open: 1, close: 1 });
      expect(preview.data!.text).toBe(true);
      await expect(s.resolve('/branches/b1/a.sql')).rejects.toThrow(/nothing was written[\s\S]*1 '<<<<<<<' and 1 '>>>>>>>'/);
    });

    it('runs resolve --accept working on that one path once the markers are gone', async () => {
      fs.writeFileSync(file, Buffer.from('a\r\nb \xe7\r\n', 'latin1'));
      const s = svc();
      s.statuses = conflicted();
      const r = await s.resolve('/branches/b1/a.sql');
      expect(r.command).toContain(`resolve --accept working ${file}`);
    });

    it('always refuses a tree conflict', async () => {
      const s = svc();
      s.statuses = conflicted({ status: 'normal', treeConflicted: true });
      await expect(s.resolve('/branches/b1/a.sql')).rejects.toThrow(/tree conflict/);
    });

    it('refuses a path that is not in conflict', async () => {
      const s = svc();
      s.statuses = [];
      await expect(s.resolve('/branches/b1/a.sql')).rejects.toThrow(/not in conflict/);
    });
  });
});

describe('rules 5 and 6 — merge and resolve are never killed, wc.db errors say stop', () => {
  const serviceSrc = fs.readFileSync(path.join(process.cwd(), 'tools', 'svn-service.ts'), 'utf8');
  const methodBody = (signature: string): string => {
    const rest = serviceSrc.slice(serviceSrc.indexOf(signature));
    return rest.slice(0, rest.indexOf('\n  /**', 10));
  };

  it.each(['async merge(', 'async resolve('])('%s detaches and carries no killing timeout', (signature) => {
    const body = methodBody(signature);
    expect(body).toMatch(/detachAfterMs: DETACH_AFTER_MS/);
    expect(body).not.toMatch(/\btimeout:/);
  });

  it.each([
    'svn: E155037: Previous operation has not finished; run \'cleanup\' if it was interrupted',
    'svn: E200033: sqlite[S5]: database is locked',
    'svn: E200004: Could not convert \'\\x01\' into a number',
    // Medidos numa copia da WC da fixture com o wc.db danificado de proposito.
    'svn: E200030: sqlite[S11]: database disk image is malformed',
    'svn: E155016: The working copy database at \'C:\\wc\' is corrupt.'
  ])('keeps svn\'s words and adds the stop instruction: %p', (stderr) => {
    const svc = new SvnService({ workingDirectory: 'C:/SVN' });
    expect(() => (svc as any).handleSvnError({ stderr }, 'merge')).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/STOP: .*do not run svn_cleanup/) })
    );
    expect(() => (svc as any).handleSvnError({ stderr }, 'merge')).toThrow(stderr.slice(0, 20));
  });

  it('a locked working copy says to look for a live svn process, never to run svn_cleanup', () => {
    // Medido: lock no WC_LOCK de uma copia da fixture -> svn update.
    const stderr = 'svn: E155004: Run \'svn cleanup\' to remove locks (type \'svn help cleanup\' for details)\n' +
      'svn: E155004: Working copy \'C:\\wc\\branches\' locked.';
    let message = '';
    try { (new SvnService({ workingDirectory: 'C:/SVN' }) as any).handleSvnError({ stderr }, 'merge'); }
    catch (e: any) { message = e.message; }
    expect(message).toContain(stderr);
    expect(message).toMatch(/svn_job_status[\s\S]*never run svn_cleanup while one is alive[\s\S]*do not run svn_cleanup on your own/);
    expect(message).not.toMatch(/— run svn_cleanup/);
  });

  it('does not stack a second hint on an error that already carries one', () => {
    const svc = new SvnService({ workingDirectory: 'C:/SVN' });
    let message = '';
    try { (svc as any).handleSvnError({ message: 'Failed to get SVN info: svn: E200033: x\nSTOP: ...' }, 'merge'); }
    catch (e: any) { message = e.message; }
    expect(message.match(/STOP:/g)).toHaveLength(1);
  });
});
