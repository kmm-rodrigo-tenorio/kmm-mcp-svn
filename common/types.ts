// ===== BASE TYPES =====

export interface SvnConfig {
  svnPath?: string;
  workingDirectory?: string;
  /**
   * Repository URL. When set, bare repo-relative targets like
   * `/trunk/file.sql` are resolved against it, and URL-only workflows
   * no longer require a working copy.
   */
  url?: string;
  username?: string;
  password?: string;
  timeout?: number;
}

export interface SvnResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  command: string;
  workingDirectory: string;
  executionTime?: number;
  /**
   * The revision the command wrote, when it wrote one. Present even if svn then
   * exited non-zero — see `warning`.
   */
  committedRevision?: number;
  /**
   * The operation SUCCEEDED and something after it did not. Distinct from
   * `error`, which means it did not happen. A caller that retries on `warning`
   * duplicates work that is already committed.
   */
  warning?: string;
  /**
   * The command outlasted its detach threshold and is STILL RUNNING. Not a
   * failure, and not a partial result: nothing about the outcome is known yet.
   * Look it up with the job id, and verify the effect with `svn info` on the
   * target rather than by repeating the command.
   */
  detached?: boolean;
  jobId?: string;
}

export class SvnError extends Error {
  code?: number;
  stderr?: string;
  /**
   * ⚠ stdout matters on FAILURE too. `svn commit` prints `Committed revision N.`
   * on stdout and can still exit non-zero when a post-commit step fails — the
   * commit is in the repository and only the local bookkeeping broke. Dropping
   * stdout here is what made a successful commit look like a failed one, and a
   * retry on top of that is a DOUBLE COMMIT.
   */
  stdout?: string;
  command?: string;

  constructor(message: string) {
    super(message);
    this.name = 'SvnError';
  }
}

// ===== REPOSITORY INFORMATION TYPES =====

export interface SvnInfo {
  path: string;
  workingCopyRootPath: string;
  url: string;
  relativeUrl: string;
  repositoryRoot: string;
  repositoryUuid: string;
  revision: number;
  nodeKind: 'file' | 'directory';
  /** empty | files | immediates | infinity. Ausente quando o svn nao reporta. */
  depth?: string;
  schedule: string;
  lastChangedAuthor: string;
  lastChangedRev: number;
  lastChangedDate: string;
  textLastUpdated?: string;
  checksum?: string;
}

export interface SvnStatus {
  path: string;
  status: 'unversioned' | 'added' | 'deleted' | 'modified' | 'replaced' | 'merged' | 'conflicted' | 'ignored' | 'none' | 'normal' | 'external' | 'incomplete';
  revision?: number;
  changedRev?: number;
  changedAuthor?: string;
  changedDate?: string;
}

export interface SvnLogEntry {
  revision: number;
  author: string;
  date: string;
  message: string;
  changedPaths?: SvnChangedPath[];
}

export interface SvnChangedPath {
  action: 'A' | 'D' | 'M' | 'R';
  path: string;
  copyFromPath?: string;
  copyFromRev?: number;
}

// ===== DIFF TYPES =====

export interface SvnDiff {
  oldPath: string;
  newPath: string;
  oldRevision?: number;
  newRevision?: number;
  hunks: SvnDiffHunk[];
}

export interface SvnDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: SvnDiffLine[];
}

export interface SvnDiffLine {
  type: 'context' | 'added' | 'deleted';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

// ===== BRANCH TYPES =====

export interface SvnBranch {
  name: string;
  url: string;
  lastChangedRev: number;
  lastChangedAuthor: string;
  lastChangedDate: string;
}

export interface SvnMergeInfo {
  sourcePath: string;
  mergedRevisions: number[];
  eligibleRevisions: number[];
}

// ===== PROPERTY TYPES =====

export interface SvnProperty {
  name: string;
  value: string;
  path: string;
}

export interface SvnPropertyList {
  path: string;
  properties: Record<string, string>;
}

// ===== LOCK TYPES =====

export interface SvnLock {
  path: string;
  token: string;
  owner: string;
  comment?: string;
  created: string;
  expires?: string;
}

// ===== BLAME/ANNOTATION TYPES =====

export interface SvnBlameLine {
  revision: number;
  author: string;
  date: string;
  lineNumber: number;
  content: string;
}

export interface SvnBlame {
  path: string;
  lines: SvnBlameLine[];
}

// ===== FILE OPERATION TYPES =====

export interface SvnAddOptions {
  force?: boolean;
  noIgnore?: boolean;
  autoProps?: boolean;
  noAutoProps?: boolean;
  parents?: boolean;
}

export interface SvnCommitOptions {
  message: string;
  file?: string;
  force?: boolean;
  keepLocks?: boolean;
  noUnlock?: boolean;
  targets?: string[];
  /** Per-call timeout in ms. See executeSvnCommand. */
  timeout?: number;
}

export interface SvnUpdateOptions {
  revision?: number | 'HEAD' | 'BASE' | 'COMMITTED' | 'PREV';
  force?: boolean;
  ignoreExternals?: boolean;
  acceptConflicts?: 'postpone' | 'base' | 'mine-conflict' | 'theirs-conflict' | 'mine-full' | 'theirs-full';
  depth?: 'empty' | 'files' | 'immediates' | 'infinity';
  setDepth?: 'empty' | 'files' | 'immediates' | 'infinity' | 'exclude';
  /** Per-call timeout in ms. Network-bound: defaults higher than the global one. */
  timeout?: number;
}

export interface SvnCheckoutOptions {
  revision?: number | 'HEAD';
  depth?: 'empty' | 'files' | 'immediates' | 'infinity';
  force?: boolean;
  ignoreExternals?: boolean;
  /** Per-call timeout in ms. Network-bound: defaults higher than the global one. */
  timeout?: number;
}

export interface SvnCopyOptions {
  message?: string;
  revision?: number | 'HEAD' | 'BASE' | 'COMMITTED' | 'PREV';
  parents?: boolean;
}

export interface SvnMoveOptions {
  message?: string;
  force?: boolean;
  parents?: boolean;
}

export interface SvnDeleteOptions {
  force?: boolean;
  keepLocal?: boolean;
}

// ===== MERGE TYPES =====

export interface SvnMergeOptions {
  dryRun?: boolean;
  force?: boolean;
  ignoreAncestry?: boolean;
  recordOnly?: boolean;
  acceptConflicts?: 'postpone' | 'base' | 'mine-conflict' | 'theirs-conflict' | 'mine-full' | 'theirs-full';
}

// ===== SWITCH TYPES =====

export interface SvnSwitchOptions {
  revision?: number | 'HEAD';
  force?: boolean;
  ignoreExternals?: boolean;
  acceptConflicts?: 'postpone' | 'base' | 'mine-conflict' | 'theirs-conflict' | 'mine-full' | 'theirs-full';
}

// ===== RESOLVE TYPES =====

export interface SvnResolveOptions {
  accept: 'base' | 'working' | 'mine-conflict' | 'theirs-conflict' | 'mine-full' | 'theirs-full';
  recursive?: boolean;
}

// ===== IMPORT/EXPORT TYPES =====

export interface SvnImportOptions {
  message: string;
  noIgnore?: boolean;
  force?: boolean;
  noAutoProps?: boolean;
  autoProps?: boolean;
}

export interface SvnExportOptions {
  revision?: number | 'HEAD';
  force?: boolean;
  nativeEol?: 'LF' | 'CR' | 'CRLF';
  ignoreExternals?: boolean;
}

// ===== CAT / LIST TYPES =====

export interface SvnCatOptions {
  revision?: number | 'HEAD' | 'BASE' | 'COMMITTED' | 'PREV' | string;
  /**
   * Write the content to this file instead of returning it. The answer carries the
   * path, the size and the detected encoding — a real source file here is hundreds
   * of KB, and returning it inline spends the caller's whole context on one read.
   */
  saveTo?: string;
  /** Return only the lines matching this regex, each with its line number. */
  pattern?: string;
  /** Lines of context around each `pattern` match. */
  contextLines?: number;
  timeout?: number;
}

export interface SvnLogOptions {
  /**
   * Stop at the revision that created this branch, so the answer is the branch's
   * OWN history rather than everything inherited from the line it was copied from.
   */
  stopOnCopy?: boolean;
  /** Include changed paths, and with them a copy's `copyfrom-path`/`copyfrom-rev`. */
  verbose?: boolean;
  timeout?: number;
}

export interface SvnDiffOptions {
  /** What a single revision changed — `svn diff --change N`, i.e. `-r N-1:N`. */
  changeRevision?: number;
  timeout?: number;
}

export interface SvnBlameOptions {
  revision?: number | 'HEAD' | 'BASE' | 'COMMITTED' | 'PREV' | string;
  /** 1-based, inclusive. Blame of a whole large file is not usable in an answer. */
  startLine?: number;
  endLine?: number;
  /** Alternative to the line range: only lines matching this regex. */
  pattern?: string;
  timeout?: number;
}

export interface SvnListOptions {
  revision?: number | 'HEAD' | 'BASE' | 'COMMITTED' | 'PREV' | string;
  verbose?: boolean;
  recursive?: boolean;
  depth?: 'empty' | 'files' | 'immediates' | 'infinity';
  includeExternals?: boolean;
}

export interface SvnListEntry {
  name: string;
  kind: 'file' | 'dir';
  size?: number;
  revision?: number;
  author?: string;
  date?: string;
}

// ===== ANALYSIS TOOL TYPES =====

export interface SvnWorkingCopySummary {
  info: SvnInfo;
  status: SvnStatus[];
  branches: SvnBranch[];
  conflictedFiles: string[];
  modifiedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  unversionedFiles: string[];
  totalFiles: number;
  totalSize?: number;
}

export interface SvnBranchComparison {
  sourceBranch: string;
  targetBranch: string;
  differences: SvnLogEntry[];
  mergeInfo: SvnMergeInfo;
  conflictingFiles: string[];
}

export interface SvnHealthCheck {
  status: 'healthy' | 'warning' | 'error';
  issues: SvnHealthIssue[];
  workingCopyValid: boolean;
  repositoryAccessible: boolean;
  conflictsDetected: boolean;
  uncommittedChanges: boolean;
  lastUpdate: string;
}

export interface SvnHealthIssue {
  type: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  suggestion?: string;
}

// ===== BATCH OPERATION TYPES =====

export interface SvnBatchOperation {
  type: 'add' | 'delete' | 'move' | 'copy' | 'revert';
  source: string;
  target?: string;
  options?: any;
}

export interface SvnBatchResult {
  operation: SvnBatchOperation;
  success: boolean;
  error?: string;
  result?: any;
}

// ===== CONSTANTS =====

export const SVN_STATUS_CODES = {
  ' ': 'none',
  'A': 'added',
  'D': 'deleted',
  'M': 'modified',
  'R': 'replaced',
  'C': 'conflicted',
  'X': 'external',
  'I': 'ignored',
  '?': 'unversioned',
  '!': 'missing',
  '~': 'obstructed'
} as const;

export const SVN_ACTION_CODES = {
  'A': 'added',
  'D': 'deleted',
  'M': 'modified',
  'R': 'replaced'
} as const; 