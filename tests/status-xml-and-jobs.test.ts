import { describe, it, expect, beforeEach } from '@jest/globals';
import { parseStatusOutput, statusLabel, isLocalModification, createSvnConfig, executeSvnCommand } from '../common/utils';
import {
  registerJob, appendJobOutput, finishJob, getJob, listJobs,
  runningJobs, findOverlappingJob, resetJobs
} from '../common/jobs';

/**
 * The XML below is the shape `svn status --xml` really emits, including the case
 * that broke the old parser: a directory with a property-only modification, whose
 * plain-text form starts with a SPACE (' M') and so lost its first path character
 * to the global trim plus a fixed `substring(8)`.
 */
const STATUS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path=".">
<entry path="C:\\SVN\\Software\\_dev\\Modulos\\Fiscal\\CT-e\\_baseline\\Branches\\Ticket 259210.4">
<wc-status props="modified" item="normal" revision="641543">
<commit revision="640875">
<author>eric.galves</author>
<date>2026-08-06T22:01:34.123456Z</date>
</commit>
</wc-status>
</entry>
<entry path="C:\\SVN\\Software\\_dev\\Modulos\\Fiscal\\CT-e\\_baseline\\Branches\\Ticket 259210.4\\Java\\CTe\\src\\Foo &amp; Bar.java">
<wc-status props="none" item="modified" revision="641543"></wc-status>
</entry>
<entry path="C:\\SVN\\novo.sql">
<wc-status props="none" item="unversioned"></wc-status>
</entry>
</target>
</status>`;

describe('parseStatusOutput over --xml', () => {
  const parsed = parseStatusOutput(STATUS_XML);

  it('keeps the drive letter on the first entry', () => {
    // The exact defect seen live: "C:\\SVN\\..." came back as ":\\SVN\\...", because
    // a property-only change prints ' M', the global trim ate that leading space,
    // and substring(8) then ate the 'C'.
    expect(parsed[0].path.startsWith('C:\\SVN\\')).toBe(true);
    expect(parsed.every(s => !s.path.startsWith(':'))).toBe(true);
  });

  it('keeps paths that contain spaces intact', () => {
    expect(parsed[0].path).toContain('Ticket 259210.4');
    expect(parsed[1].path).toContain('Ticket 259210.4');
  });

  it('unescapes XML entities in the path', () => {
    expect(parsed[1].path).toContain('Foo & Bar.java');
    expect(parsed[1].path).not.toContain('&amp;');
  });

  it('reads the status from the item attribute, not from a column', () => {
    expect(parsed[0].status).toBe('normal');
    expect(parsed[1].status).toBe('modified');
    expect(parsed[2].status).toBe('unversioned');
  });

  it('fills the fields the type always declared and the old parser never set', () => {
    expect(parsed[0].revision).toBe(641543);
    expect(parsed[0].changedRev).toBe(640875);
    expect(parsed[0].changedAuthor).toBe('eric.galves');
    expect(parsed[0].changedDate).toContain('2026-08-06');
  });

  it('returns nothing for empty or non-XML input instead of throwing', () => {
    expect(parseStatusOutput('')).toEqual([]);
    expect(parseStatusOutput('not xml at all')).toEqual([]);
  });
});

/**
 * `svn status --xml` real de um branch logo depois de um merge com os tres tipos de
 * conflito (fixture do interno-26_10_08, svn 1.14.5). Conflito de arvore e de
 * propriedade vem em atributo proprio, com `item="normal"` — so o `item` nao basta.
 */
const AFTER_MERGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path="branches\\b1">
<entry
   path="branches\\b1">
<wc-status
   item="normal"
   revision="11"
   props="modified">
<commit
   revision="6">
<author>dev.branch</author>
<date>2026-10-08T14:59:20.553057Z</date>
</commit>
</wc-status>
</entry>
<entry
   path="branches\\b1\\a.sql">
<wc-status
   item="conflicted"
   revision="11"
   props="none">
</wc-status>
</entry>
<entry
   path="branches\\b1\\a.sql.working">
<wc-status
   item="unversioned"
   props="none">
</wc-status>
</entry>
<entry
   path="branches\\b1\\b.java">
<wc-status
   item="normal"
   revision="11"
   props="conflicted">
</wc-status>
</entry>
<entry
   path="branches\\b1\\d.txt">
<wc-status
   item="normal"
   revision="11"
   props="none"
   tree-conflicted="true">
</wc-status>
</entry>
</target>
</status>`;

describe('parseStatusOutput — property and tree state after a merge (AC-6)', () => {
  const parsed = parseStatusOutput(AFTER_MERGE_XML);
  const byName = (n: string) => parsed.find(s => s.path.endsWith(n))!;

  it('reads props and tree-conflicted from their own attributes', () => {
    expect(byName('branches\\b1')).toMatchObject({ status: 'normal', props: 'modified' });
    expect(byName('b.java')).toMatchObject({ status: 'normal', props: 'conflicted' });
    expect(byName('d.txt')).toMatchObject({ status: 'normal', treeConflicted: true });
    expect(byName('a.sql').treeConflicted).toBeUndefined();
  });

  it('labels none of them NORMAL', () => {
    expect(statusLabel(byName('branches\\b1'))).toBe('PROPERTIES MODIFIED');
    expect(statusLabel(byName('b.java'))).toBe('PROPERTY CONFLICT');
    expect(statusLabel(byName('d.txt'))).toBe('TREE CONFLICT');
    expect(statusLabel(byName('a.sql'))).toBe('CONFLICTED');
    expect(statusLabel(byName('a.sql.working'))).toBe('UNVERSIONED');
  });

  it('counts all four as local modification, and the unversioned leftover not', () => {
    expect(parsed.filter(isLocalModification).map(s => s.path.split('\\').pop()))
      .toEqual(['b1', 'a.sql', 'b.java', 'd.txt']);
  });
});

describe('job registry', () => {
  beforeEach(() => resetJobs());

  it('records a running job and then its outcome', () => {
    const job = registerJob({ command: 'svn update x', target: 'C:/SVN/x', cwd: 'C:/SVN' });
    expect(job.state).toBe('running');
    expect(runningJobs()).toHaveLength(1);

    appendJobOutput(job.id, 'stdout', 'A  file.sql\n');
    finishJob(job.id, 0);

    const after = getJob(job.id)!;
    expect(after.state).toBe('done');
    expect(after.exitCode).toBe(0);
    expect(after.stdoutTail).toContain('file.sql');
    expect(runningJobs()).toHaveLength(0);
  });

  it('marks a non-zero exit as failed', () => {
    const job = registerJob({ command: 'svn update x', cwd: 'C:/SVN' });
    finishJob(job.id, 1);
    expect(getJob(job.id)!.state).toBe('failed');
  });

  it('caps the output tail so a long checkout cannot grow without bound', () => {
    const job = registerJob({ command: 'svn checkout', cwd: 'C:/SVN' });
    for (let i = 0; i < 500; i++) appendJobOutput(job.id, 'stdout', `A  file-${i}.java\n`);
    expect(getJob(job.id)!.stdoutTail.length).toBeLessThanOrEqual(4000);
    // ...and it keeps the END, which is the part that says how it went.
    expect(getJob(job.id)!.stdoutTail).toContain('file-499.java');
  });

  it('lists newest first', () => {
    const a = registerJob({ command: 'a', cwd: 'C:/SVN' });
    const b = registerJob({ command: 'b', cwd: 'C:/SVN' });
    expect(listJobs()[0].id).toBe(b.id);
    expect(listJobs()[1].id).toBe(a.id);
  });
});

describe('findOverlappingJob — stop two svn fighting over one working copy', () => {
  beforeEach(() => resetJobs());

  it('matches the same path', () => {
    registerJob({ command: 'svn update', target: 'C:/SVN/Software/Modulos', cwd: 'C:/SVN' });
    expect(findOverlappingJob('C:/SVN/Software/Modulos')?.target).toBe('C:/SVN/Software/Modulos');
  });

  it('matches a child of a running target, and a parent of one', () => {
    registerJob({ command: 'svn update', target: 'C:/SVN/Software/Modulos', cwd: 'C:/SVN' });
    expect(findOverlappingJob('C:/SVN/Software/Modulos/Fiscal')).toBeDefined();
    expect(findOverlappingJob('C:/SVN/Software')).toBeDefined();
  });

  it('ignores separator and case differences', () => {
    registerJob({ command: 'svn update', target: 'C:/SVN/Software/Modulos', cwd: 'C:/SVN' });
    expect(findOverlappingJob('c:\\svn\\software\\modulos\\')).toBeDefined();
  });

  it('does not match a sibling', () => {
    registerJob({ command: 'svn update', target: 'C:/SVN/Software/Modulos', cwd: 'C:/SVN' });
    expect(findOverlappingJob('C:/SVN/Software/ModulosOutros')).toBeUndefined();
    expect(findOverlappingJob('C:/SVN/Delphi')).toBeUndefined();
  });

  it('ignores jobs that already finished', () => {
    const job = registerJob({ command: 'svn update', target: 'C:/SVN/Software', cwd: 'C:/SVN' });
    finishJob(job.id, 0);
    expect(findOverlappingJob('C:/SVN/Software')).toBeUndefined();
  });
});

describe('detaching leaves the process running', () => {
  beforeEach(() => resetJobs());

  it('answers early and lets the command finish on its own', async () => {
    // The point of the whole design: the old code killed the process on its
    // deadline, and the MCP client's own timeout then reported a SUCCESSFUL
    // operation as failed. Detaching must do the opposite: answer, and leave it be.
    //
    // Node itself stands in for a slow svn: predictable duration and exit 0.
    // The stand-in has to tolerate an unknown trailing argument, because
    // buildAuthArgs always appends `--non-interactive`. `ping` does not - it
    // rejects the option and exits within milliseconds, BEFORE the threshold,
    // which exercises the ordinary failure path and says nothing about detaching.
    const cfg = createSvnConfig({
      svnPath: process.execPath,
      workingDirectory: process.cwd(),
      timeout: 60_000
    });

    const before = Date.now();
    // The trailing `--` ends node's own option parsing, so the appended
    // `--non-interactive` lands in argv rather than being rejected as a node flag.
    const response = await executeSvnCommand(cfg, ['-e', 'setTimeout(function(){}, 2500)', '--'], {
      detachAfterMs: 300,
      target: 'C:/SVN/detach-probe'
    });
    const answeredAfter = Date.now() - before;

    expect(response.detached).toBe(true);
    expect(response.jobId).toBeDefined();
    // Answered promptly, nowhere near the command's own duration.
    expect(answeredAfter).toBeLessThan(2_000);

    const job = getJob(response.jobId!)!;
    expect(job.state).toBe('running');
    expect(job.target).toBe('C:/SVN/detach-probe');

    // Wait past the threshold and confirm it ran to completion rather than being
    // cut down at 300ms.
    await new Promise(r => setTimeout(r, 4_000));
    const finished = getJob(response.jobId!)!;
    expect(finished.state).not.toBe('running');
    expect(finished.finishedAt).toBeDefined();
    expect(finished.finishedAt! - finished.startedAt).toBeGreaterThan(1_000);
  }, 15_000);
});
