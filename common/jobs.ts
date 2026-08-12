/**
 * Registry of SVN operations that outlived the tool call that started them.
 *
 * Why this exists: there is a request timeout ABOVE this server — the MCP client
 * gives up at around 60s — and no server-side setting reaches it. A real
 * `svn update --set-depth infinity` on a module branch (measured: 2378 files,
 * 52.5 MB) runs past that. Before this, the call returned a protocol timeout
 * error while svn carried on and finished successfully: an operation that WORKED,
 * reported as a failure. That is worse than failing, because the obvious reaction
 * is to retry on top of a state that is already fine, and a second svn fighting
 * for the working-copy lock can leave it locked.
 *
 * So past a threshold the command is DETACHED rather than killed, and its outcome
 * is recorded here for a later lookup. The server is long-lived (stdio), so an
 * in-memory map is enough; jobs do not need to survive a restart, because the way
 * to verify is `svn info` on the target, not this registry.
 */

export type SvnJobState = 'running' | 'done' | 'failed';

export interface SvnJob {
  id: string;
  /**
   * Monotonic creation order. Ordering by `startedAt` alone is not deterministic:
   * two jobs registered inside the same millisecond tie, and the clock is the
   * wrong authority for "which came first" anyway.
   */
  seq: number;
  /** Display command, already redacted — never the real argv. */
  command: string;
  /** What the operation acts on, so the caller can verify it afterwards. */
  target?: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  state: SvnJobState;
  exitCode?: number;
  /** Last chunk of stdout. Capped: a checkout prints one line per file. */
  stdoutTail: string;
  stderrTail: string;
}

/** Enough to see what happened, small enough to keep many jobs. */
const TAIL_MAX = 4000;
/** Oldest finished jobs are dropped past this. Running jobs are never dropped. */
const JOB_MAX = 50;

const jobs = new Map<string, SvnJob>();
let sequence = 0;

function tail(existing: string, chunk: string): string {
  const joined = existing + chunk;
  return joined.length <= TAIL_MAX ? joined : joined.slice(joined.length - TAIL_MAX);
}

/** Drop the oldest finished jobs, never a running one. */
function prune(): void {
  if (jobs.size <= JOB_MAX) return;
  const finished = [...jobs.values()]
    .filter(j => j.state !== 'running')
    .sort((a, b) => a.seq - b.seq);
  for (const job of finished) {
    if (jobs.size <= JOB_MAX) break;
    jobs.delete(job.id);
  }
}

export function registerJob(input: { command: string; target?: string; cwd: string }): SvnJob {
  sequence += 1;
  const job: SvnJob = {
    id: `svnjob-${sequence}`,
    seq: sequence,
    command: input.command,
    target: input.target,
    cwd: input.cwd,
    startedAt: Date.now(),
    state: 'running',
    stdoutTail: '',
    stderrTail: ''
  };
  jobs.set(job.id, job);
  prune();
  return job;
}

export function appendJobOutput(id: string, stream: 'stdout' | 'stderr', chunk: string): void {
  const job = jobs.get(id);
  if (!job) return;
  if (stream === 'stdout') job.stdoutTail = tail(job.stdoutTail, chunk);
  else job.stderrTail = tail(job.stderrTail, chunk);
}

export function finishJob(id: string, exitCode: number | null, failureNote?: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.finishedAt = Date.now();
  job.exitCode = exitCode ?? undefined;
  job.state = exitCode === 0 ? 'done' : 'failed';
  if (failureNote) job.stderrTail = tail(job.stderrTail, `\n${failureNote}`);
}

export function getJob(id: string): SvnJob | undefined {
  return jobs.get(id);
}

/** Newest first. */
export function listJobs(limit = 20): SvnJob[] {
  return [...jobs.values()].sort((a, b) => b.seq - a.seq).slice(0, limit);
}

export function runningJobs(): SvnJob[] {
  return [...jobs.values()].filter(j => j.state === 'running');
}

function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * A running job whose target overlaps `target` — either one containing the other.
 *
 * Two svn processes on overlapping paths of the same working copy fight for its
 * lock, and losing that fight can leave the copy locked and needing `cleanup`.
 * Refusing the second call is far cheaper than explaining the aftermath.
 */
export function findOverlappingJob(target?: string): SvnJob | undefined {
  if (!target) return undefined;
  const a = normalizeForCompare(target);
  return runningJobs().find(job => {
    if (!job.target) return false;
    const b = normalizeForCompare(job.target);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  });
}

/** For tests: forget everything. */
export function resetJobs(): void {
  jobs.clear();
  sequence = 0;
}
