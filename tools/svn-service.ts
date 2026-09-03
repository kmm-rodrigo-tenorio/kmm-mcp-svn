import {
  SvnConfig,
  SvnResponse,
  SvnInfo,
  SvnStatus,
  SvnLogEntry,
  SvnCheckoutOptions,
  SvnUpdateOptions,
  SvnCommitOptions,
  SvnAddOptions,
  SvnDeleteOptions,
  SvnCatOptions,
  SvnLogOptions,
  SvnDiffOptions,
  SvnBlameOptions,
  SvnBlameLine,
  SvnListOptions,
  SvnListEntry,
  SvnError
} from '../common/types.js';

import {
  createSvnConfig,
  executeSvnCommand,
  parseInfoOutput,
  parseStatusOutput,
  parseLogOutput,
  parseListOutput,
  validateSvnInstallation,
  isWorkingCopy,
  normalizePath,
  validatePath,
  validateRevision,
  validateSvnUrl,
  resolveTarget,
  resolveWorkingCopyPath,
  cleanOutput,
  formatDuration,
  clearSvnCredentials,
  skippedTargetReason,
  describeEncoding,
  matchLines,
  parseBlameOutput
} from '../common/utils.js';

import { findOverlappingJob } from '../common/jobs.js';

import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

/**
 * Default timeout for the network-bound commands (checkout, update), in ms.
 *
 * The global default is 30 s, which is right for a local `status` and far too
 * short for pulling a module branch over the network. Keeping one number for both
 * meant the slow commands died with a SIGTERM that looked like a repository error.
 */
export const NETWORK_TIMEOUT_MS = 300_000;

/**
 * How long a slow command is awaited before it is DETACHED and reported as still
 * running.
 *
 * Sized against the constraint that actually bites: the MCP client abandons a
 * request at around 60s, and no server-side timeout reaches that. Answering at 30s
 * leaves comfortable room, so a long operation is reported honestly as "running"
 * instead of surfacing as a protocol timeout on an operation that in fact
 * succeeded.
 */
export const DETACH_AFTER_MS = 30_000;

export class SvnService {
  private config: SvnConfig;

  constructor(config: Partial<SvnConfig> = {}) {
    this.config = createSvnConfig(config);
  }

  /**
   * Helper function to handle common SVN errors
   */
  private handleSvnError(error: any, operation: string): never {
    // ⚠ The hint is ADDED to svn's own words, never substituted for them. These
    // canned lines used to replace the reason entirely, which turned a precise
    // E155007 about one unfetched path into a blanket claim that the whole
    // working copy is invalid — wrong, and it hid the path that actually failed.
    const detail: string = (error.stderr && error.stderr.length > 0) ? error.stderr : error.message;
    let hint = '';

    if (detail.includes('E155007') || detail.includes('not a working copy')) {
      hint = `Hint: that path is not in the working copy. Either '${this.config.workingDirectory}' is not a working copy at all, or the path was never fetched into it — a sparse checkout needs its parent directories pulled at depth empty first.`;
    } else if (detail.includes('E175002') || detail.includes('Unable to connect')) {
      hint = `Hint: cannot reach the repository. Check the connection and the credentials.`;
    } else if (detail.includes('E170001') || detail.includes('Authentication failed')) {
      hint = `Hint: authentication failed. Check the SVN username and password.`;
    } else if (detail.includes('E155036') || detail.includes('working copy locked')) {
      hint = `Hint: the working copy is locked — run svn_cleanup.`;
    } else if (detail.includes('E200030') || detail.includes('sqlite')) {
      hint = `Hint: working copy database error — run svn_cleanup.`;
    }

    throw new SvnError(`Failed to ${operation}: ${detail}${hint ? `\n${hint}` : ''}`);
  }

  /**
   * Refuse a second slow command on a path that overlaps one already running.
   *
   * Two svn processes on overlapping paths of the same working copy contend for
   * its lock; losing that contention can leave the copy locked and needing
   * `cleanup`. Since a detached command answers before it finishes, the caller has
   * every reason to fire another — so the guard belongs here, not in a docstring.
   */
  private assertNoOverlappingJob(target?: string): void {
    const clash = findOverlappingJob(target);
    if (clash) {
      throw new SvnError(
        `Another SVN operation is still running on an overlapping path — job ${clash.id}, ` +
        `started ${Math.round((Date.now() - clash.startedAt) / 1000)}s ago on ${clash.target}. ` +
        `Running a second one would fight it for the working-copy lock. Check it with ` +
        `svn_job_status and wait for it to finish.`
      );
    }
  }

  /**
   * Verify that SVN is available and correctly configured
   */
  async healthCheck(): Promise<SvnResponse<{
    svnAvailable: boolean;
    version?: string;
    workingCopyValid?: boolean;
    repositoryAccessible?: boolean;
  }>> {
    try {
      // Verify SVN installation
      const svnAvailable = await validateSvnInstallation(this.config);
      if (!svnAvailable) {
        return {
          success: false,
          error: 'SVN is not available in the system PATH',
          command: 'svn --version',
          workingDirectory: this.config.workingDirectory!
        };
      }

      // Get SVN version
      const versionResponse = await executeSvnCommand(this.config, ['--version', '--quiet']);
      const version = versionResponse.data as string;

      // Check whether we are inside a working copy
      const workingCopyValid = await isWorkingCopy(this.config.workingDirectory!);

      let repositoryAccessible = false;
      if (workingCopyValid) {
        try {
          await this.getInfo();
          repositoryAccessible = true;
        } catch (error) {
          repositoryAccessible = false;
        }
      }

      return {
        success: true,
        data: {
          svnAvailable,
          version: version.trim(),
          workingCopyValid,
          repositoryAccessible
        },
        command: 'health-check',
        workingDirectory: this.config.workingDirectory!
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        command: 'health-check',
        workingDirectory: this.config.workingDirectory!
      };
    }
  }

  /**
   * Get information about the working copy or a specific directory
   */
  async getInfo(path?: string): Promise<SvnResponse<SvnInfo>> {
    try {
      const args = ['info'];
      if (path) {
        args.push(resolveTarget(path, this.config).value);
      }

      const response = await executeSvnCommand(this.config, args);
      const info = parseInfoOutput(cleanOutput(response.data as string));

      return {
        success: true,
        data: info,
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      this.handleSvnError(error, 'get SVN info');
    }
  }

  /**
   * Get the status of files in the working copy
   */
  async getStatus(path?: string, showAll: boolean = false): Promise<SvnResponse<SvnStatus[]>> {
    try {
      // --xml, not the plain columns: see parseStatusOutput for why the column
      // arithmetic could not hold.
      const args = ['status', '--xml'];

      if (path) {
        // resolveWorkingCopyPath, not normalizePath: it maps a repo-relative
        // "/Software/..." into the working copy and refuses a URL outright.
        // `svn status` is a working-copy command — svn itself rejects URLs — so
        // the old code silently turned one into a nonsense local path.
        args.push(resolveWorkingCopyPath(path, this.config));
      }

      let response;

      // If showAll is true, try first with --show-updates
      if (showAll) {
        try {
          const argsWithUpdates = [...args, '--show-updates'];
          response = await executeSvnCommand(this.config, argsWithUpdates);
        } catch (error: any) {
          // If --show-updates fails, fall back to local status only
          console.warn(`Warning: --show-updates failed, falling back to local status only: ${error.message}`);
          response = await executeSvnCommand(this.config, args);
        }
      } else {
        response = await executeSvnCommand(this.config, args);
      }

      const statusList = parseStatusOutput(cleanOutput(response.data as string));

      return {
        success: true,
        data: statusList,
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      this.handleSvnError(error, 'get SVN status');
    }
  }

  /**
   * Get change history (log)
   */
  async getLog(
    path?: string,
    limit?: number,
    revision?: string,
    options: SvnLogOptions = {}
  ): Promise<SvnResponse<SvnLogEntry[]>> {
    try {
      // `--xml` is not optional here: the plain-text form has no reliable place to
      // read a copy's origin from, and that origin is a required check.
      const args = ['log', '--xml'];

      if (limit && limit > 0) {
        args.push('--limit', limit.toString());
      }

      if (revision) {
        args.push('--revision', revision);
      }

      // Stops at the revision that created the branch, so what comes back is the
      // branch's OWN history instead of everything it inherited from the line it
      // was copied from. Without it, a branch cut from a 3-year-old baseline
      // answers with the baseline's entire log.
      if (options.stopOnCopy) {
        args.push('--stop-on-copy');
      }

      // Brings `<paths>`, and with it `copyfrom-path`/`copyfrom-rev` — the origin.
      if (options.verbose) {
        args.push('--verbose');
      }

      if (path) {
        args.push(resolveTarget(path, this.config).value);
      }

      let response;
      try {
        response = await executeSvnCommand(this.config, args);
      } catch (error: any) {
        // Detect if SVN is not installed
        if ((error.message.includes('spawn') && error.message.includes('ENOENT')) ||
            error.code === 127) {
          const enhancedError = new SvnError(
            'SVN is not installed or not found in the system PATH. Install Subversion to use this command.'
          );
          enhancedError.command = error.command;
          enhancedError.code = error.code;
          throw enhancedError;
        }

        // Detect network/connectivity errors and surface more helpful messages
        if (error.message.includes('E175002') ||
            error.message.includes('Unable to connect') ||
            error.message.includes('Connection refused') ||
            error.message.includes('Network is unreachable') ||
            error.code === 1) {

          console.warn(`Remote log failed, possible connectivity issue: ${error.message}`);

          const enhancedError = new SvnError(
            `Could not retrieve change history. Possible causes:
            - No connectivity to the SVN server
            - Credentials required but not provided
            - SVN server temporarily unreachable
            - Working copy out of sync with the remote repository`
          );
          enhancedError.command = error.command;
          enhancedError.stderr = error.stderr;
          enhancedError.code = error.code;
          throw enhancedError;
        }
        // Re-throw any other error unchanged
        throw error;
      }

      const logEntries = parseLogOutput(cleanOutput(response.data as string));

      return {
        success: true,
        data: logEntries,
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      this.handleSvnError(error, 'get SVN log');
    }
  }

  /**
   * Get differences between revisions
   */
  async getDiff(
    path?: string,
    oldRevision?: string,
    newRevision?: string,
    options: SvnDiffOptions = {}
  ): Promise<SvnResponse<string>> {
    try {
      const args = ['diff'];
      const resolved = path ? resolveTarget(path, this.config).value : undefined;

      // Reject a malformed revision here instead of letting it reach the peg
      // syntax, where svn answers `E205000: Syntax error parsing peg revision`
      // and names the garbage without naming the parameter that carried it.
      for (const [label, value] of [['oldRevision', oldRevision], ['newRevision', newRevision]] as const) {
        if (value !== undefined && !validateRevision(value)) {
          throw new SvnError(
            `Invalid ${label}: ${value} — use a number, HEAD, BASE, COMMITTED, PREV or {DATE}`
          );
        }
      }

      // What ONE revision changed. Reviewing a KMM branch means walking its own
      // revisions, and expressing that as the range `N-1:N` is arithmetic the
      // caller has to get right every time — `--change` is the same thing without
      // the subtraction.
      if (options.changeRevision !== undefined) {
        args.push('--change', String(options.changeRevision));
        if (resolved) {
          args.push(resolved);
        }
      } else if (oldRevision && newRevision) {
        const base = resolved || '.';
        args.push('--old', `${base}@${oldRevision}`);
        args.push('--new', `${base}@${newRevision}`);
      } else if (oldRevision) {
        args.push('--revision', oldRevision);
        if (resolved) {
          args.push(resolved);
        }
      } else if (resolved) {
        args.push(resolved);
      }

      // A diff can be network-bound: measured 10s for a branch against its
      // baseline, which the global 30s default would eventually cut down.
      const response = await executeSvnCommand(this.config, args, {
        timeout: options.timeout ?? NETWORK_TIMEOUT_MS
      });

      return {
        success: true,
        data: cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      throw new SvnError(`Failed to get SVN diff: ${error.message}`);
    }
  }

  /**
   * Check out a repository
   */
  async checkout(
    url: string,
    path?: string,
    options: SvnCheckoutOptions = {}
  ): Promise<SvnResponse<string>> {
    try {
      if (!validateSvnUrl(url)) {
        throw new SvnError(`Invalid SVN URL: ${url}`);
      }

      const args = ['checkout'];
      
      if (options.revision) {
        args.push('--revision', options.revision.toString());
      }
      
      if (options.depth) {
        args.push('--depth', options.depth);
      }
      
      if (options.force) {
        args.push('--force');
      }
      
      if (options.ignoreExternals) {
        args.push('--ignore-externals');
      }

      args.push(url);
      
      if (path) {
        if (!validatePath(path)) {
          throw new SvnError(`Invalid path: ${path}`);
        }
        args.push(normalizePath(path, this.config.workingDirectory));
      }

      const destination = path ? normalizePath(path, this.config.workingDirectory) : undefined;
      this.assertNoOverlappingJob(destination);

      const response = await executeSvnCommand(this.config, args, {
        timeout: options.timeout ?? NETWORK_TIMEOUT_MS,
        detachAfterMs: DETACH_AFTER_MS,
        target: destination ?? url
      });

      return {
        success: true,
        data: response.detached ? '' : cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime,
        detached: response.detached,
        jobId: response.jobId
      };

    } catch (error: any) {
      throw new SvnError(`Failed to checkout: ${error.message}`);
    }
  }

  /**
   * Update the working copy
   */
  async update(
    path?: string,
    options: SvnUpdateOptions = {}
  ): Promise<SvnResponse<string>> {
    try {
      // ⚠ `--parents` is what makes a deep path into a never-fetched branch work:
      // svn creates the missing parent directories itself, checking them out at
      // depth empty. Without it the same call dies with E155007, which reads as
      // "this is not a working copy" and actually means "that path was never
      // pulled". It is also how a SINGLE FILE is fetched. Harmless when the
      // parents are already present, so it is unconditional — same as the KMM
      // branch-manager screen, which has always shelled out
      // `svn up --parents --set-depth <depth> -r <rev> <paths>`.
      const args = ['update', '--parents'];

      if (options.revision) {
        args.push('--revision', options.revision.toString());
      }
      
      if (options.force) {
        args.push('--force');
      }
      
      if (options.ignoreExternals) {
        args.push('--ignore-externals');
      }
      
      if (options.acceptConflicts) {
        args.push('--accept', options.acceptConflicts);
      }

      if (options.depth) {
        args.push('--depth', options.depth);
      }

      // `--set-depth` is how a single folder (or a single file) is pulled into an
      // otherwise sparse working copy, and how a subtree is excluded again. It is
      // the difference between fetching one module branch and fetching every
      // branch of that module.
      if (options.setDepth) {
        args.push('--set-depth', options.setDepth);
      }

      const target = path ? resolveWorkingCopyPath(path, this.config) : this.config.workingDirectory;
      if (path) {
        args.push(target!);
      }

      this.assertNoOverlappingJob(target);

      const response = await executeSvnCommand(this.config, args, {
        timeout: options.timeout ?? NETWORK_TIMEOUT_MS,
        detachAfterMs: DETACH_AFTER_MS,
        target
      });

      // The price of `--parents`: a path svn cannot reach is skipped with exit 0
      // instead of failing. Left alone, a wrong path would answer "completed".
      if (!response.detached) {
        const skipped = skippedTargetReason(response.data as string, target);
        if (skipped) {
          throw new SvnError(
            `svn skipped the requested path instead of updating it — ${skipped}. ` +
            `Nothing was fetched. Check that '${path}' exists in the repository at this revision.`
          );
        }
      }

      return {
        success: true,
        data: response.detached ? '' : cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime,
        detached: response.detached,
        jobId: response.jobId
      };

    } catch (error: any) {
      throw new SvnError(`Failed to update: ${error.message}`);
    }
  }

  /**
   * Add files to version control
   */
  async add(
    paths: string | string[],
    options: SvnAddOptions = {}
  ): Promise<SvnResponse<string>> {
    try {
      const pathArray = Array.isArray(paths) ? paths : [paths];
      
      // Validate all paths
      for (const path of pathArray) {
        if (!validatePath(path)) {
          throw new SvnError(`Invalid path: ${path}`);
        }
      }

      const args = ['add'];
      
      if (options.force) {
        args.push('--force');
      }
      
      if (options.noIgnore) {
        args.push('--no-ignore');
      }
      
      if (options.autoProps) {
        args.push('--auto-props');
      }
      
      if (options.noAutoProps) {
        args.push('--no-auto-props');
      }
      
      if (options.parents) {
        args.push('--parents');
      }

      // Append normalized paths
      args.push(...pathArray.map(p => normalizePath(p, this.config.workingDirectory)));

      const response = await executeSvnCommand(this.config, args);

      return {
        success: true,
        data: cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      throw new SvnError(`Failed to add files: ${error.message}`);
    }
  }

  /**
   * Commit changes to the repository
   */
  async commit(
    options: SvnCommitOptions,
    paths?: string[]
  ): Promise<SvnResponse<string>> {
    try {
      if (!options.message && !options.file) {
        throw new SvnError('Commit message is required');
      }

      // ⚠ An explicit target list is mandatory. Without one, svn commits
      // everything modified below cwd — and cwd is the working-copy root, which
      // here spans several unrelated trees. A whole-tree commit in one revision
      // is not recoverable by editing; it has to be a deliberate act, so commit
      // the root path explicitly if that is really what you want.
      const targets = (paths && paths.length > 0) ? paths : options.targets;
      if (!targets || targets.length === 0) {
        throw new SvnError(
          'Refusing to commit without an explicit path list. With no targets, svn sweeps every ' +
          `modified file under ${this.config.workingDirectory} into a single revision. ` +
          'Pass the files you mean to commit. To commit an entire tree on purpose, pass its root ' +
          'path explicitly.'
        );
      }

      const args = ['commit'];
      
      if (options.message) {
        args.push('--message', options.message);
      }
      
      if (options.file) {
        args.push('--file', normalizePath(options.file, this.config.workingDirectory));
      }
      
      if (options.force) {
        args.push('--force');
      }
      
      if (options.keepLocks) {
        args.push('--keep-locks');
      }
      
      if (options.noUnlock) {
        args.push('--no-unlock');
      }

      const resolvedTargets = targets.map(p => resolveWorkingCopyPath(p, this.config));
      args.push(...resolvedTargets);

      for (const t of resolvedTargets) this.assertNoOverlappingJob(t);

      const response = await executeSvnCommand(this.config, args, {
        timeout: options.timeout,
        // A commit reported as failed and then repeated is a DOUBLE commit. Better
        // to answer "still running" and have the caller verify with svn_log.
        detachAfterMs: DETACH_AFTER_MS,
        target: resolvedTargets[0]
      });

      return {
        success: true,
        data: response.detached ? '' : cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime,
        detached: response.detached,
        jobId: response.jobId
      };

    } catch (error: any) {
      throw new SvnError(`Failed to commit: ${error.message}`);
    }
  }

  /**
   * Remove files from version control
   */
  async delete(
    paths: string | string[],
    options: SvnDeleteOptions = {}
  ): Promise<SvnResponse<string>> {
    try {
      const pathArray = Array.isArray(paths) ? paths : [paths];

      const args = ['delete'];

      if (options.force) {
        args.push('--force');
      }

      if (options.keepLocal) {
        args.push('--keep-local');
      }

      // ⚠ No `--message` here on purpose. It only means something for a delete
      // straight against a repository URL, and that path was never reachable:
      // `normalizePath` turned the URL into a local path. Offering the parameter
      // implied a working feature. A URL delete is also an immediate, irreversible
      // repository change, so resolveWorkingCopyPath refuses one outright.
      args.push(...pathArray.map(p => resolveWorkingCopyPath(p, this.config)));

      const response = await executeSvnCommand(this.config, args);

      return {
        success: true,
        data: cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      throw new SvnError(`Failed to delete files: ${error.message}`);
    }
  }

  /**
   * Revert local changes
   */
  async revert(paths: string | string[]): Promise<SvnResponse<string>> {
    try {
      const pathArray = Array.isArray(paths) ? paths : [paths];
      
      // Validate all paths
      for (const path of pathArray) {
        if (!validatePath(path)) {
          throw new SvnError(`Invalid path: ${path}`);
        }
      }

      const args = ['revert'];
      
      // Append normalized paths
      args.push(...pathArray.map(p => normalizePath(p, this.config.workingDirectory)));

      const response = await executeSvnCommand(this.config, args);

      return {
        success: true,
        data: cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      throw new SvnError(`Failed to revert files: ${error.message}`);
    }
  }

  /**
   * Clean up the working copy
   */
  async cleanup(path?: string): Promise<SvnResponse<string>> {
    try {
      const args = ['cleanup'];
      
      if (path) {
        if (!validatePath(path)) {
          throw new SvnError(`Invalid path: ${path}`);
        }
        args.push(normalizePath(path, this.config.workingDirectory));
      }

      const response = await executeSvnCommand(this.config, args);

      return {
        success: true,
        data: cleanOutput(response.data as string),
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      throw new SvnError(`Failed to cleanup: ${error.message}`);
    }
  }

  /**
   * Targeted diagnostics for problematic commands
   */
  async diagnoseCommands(): Promise<SvnResponse<{
    statusLocal: boolean;
    statusRemote: boolean;
    logBasic: boolean;
    workingCopyPath: string;
    errors: string[];
    suggestions: string[];
  }>> {
    const results = {
      statusLocal: false,
      statusRemote: false,
      logBasic: false,
      workingCopyPath: this.config.workingDirectory!,
      errors: [] as string[],
      suggestions: [] as string[]
    };

    try {
      // Test local svn status
      try {
        await executeSvnCommand(this.config, ['status']);
        results.statusLocal = true;
      } catch (error: any) {
        const errorMsg = this.categorizeError(error, 'local status');
        results.errors.push(errorMsg.message);
        if (errorMsg.suggestion) {
          results.suggestions.push(errorMsg.suggestion);
        }
      }

      // Test svn status with --show-updates
      try {
        await executeSvnCommand(this.config, ['status', '--show-updates']);
        results.statusRemote = true;
      } catch (error: any) {
        const errorMsg = this.categorizeError(error, 'remote status');
        results.errors.push(errorMsg.message);
        if (errorMsg.suggestion) {
          results.suggestions.push(errorMsg.suggestion);
        }
      }

      // Test basic svn log
      try {
        await executeSvnCommand(this.config, ['log', '--limit', '1']);
        results.logBasic = true;
      } catch (error: any) {
        const errorMsg = this.categorizeError(error, 'basic log');
        results.errors.push(errorMsg.message);
        if (errorMsg.suggestion) {
          results.suggestions.push(errorMsg.suggestion);
        }
      }

      // Add general suggestions based on the results
      if (!results.statusRemote && !results.logBasic && results.statusLocal) {
        results.suggestions.push('Remote commands fail but the local one works. Review network connectivity and SVN credentials.');
      }

      return {
        success: true,
        data: results,
        command: 'diagnostic',
        workingDirectory: this.config.workingDirectory!
      };

    } catch (error: any) {
      results.errors.push(`General error: ${error.message}`);
      return {
        success: false,
        data: results,
        error: error.message,
        command: 'diagnostic',
        workingDirectory: this.config.workingDirectory!
      };
    }
  }

  /**
   * Categorize errors and provide specific suggestions
   */
  private categorizeError(error: any, commandType: string): { message: string; suggestion?: string } {
    const baseMessage = `${commandType} failed`;

    // SVN not found in the system
    if ((error.message.includes('spawn') && error.message.includes('ENOENT')) ||
        error.code === 127) {
      return {
        message: `${baseMessage}: SVN is not installed or not found in PATH`,
        suggestion: 'Install SVN (subversion) or make sure it is available in the system PATH'
      };
    }

    // Connectivity errors
    if (error.message.includes('E175002') ||
        error.message.includes('Unable to connect') ||
        error.message.includes('Connection refused') ||
        error.message.includes('Network is unreachable')) {
      return {
        message: `${baseMessage}: No connectivity to the SVN server`,
        suggestion: 'Check your internet connection and that the SVN server is reachable'
      };
    }

    // Authentication errors - too many attempts
    if (error.message.includes('E215004') ||
        error.message.includes('No more credentials') ||
        error.message.includes('we tried too many times')) {
      return {
        message: `${baseMessage}: Too many failed authentication attempts`,
        suggestion: 'Credentials may be incorrect or cached. Clear the SVN credentials cache and verify SVN_USERNAME and SVN_PASSWORD'
      };
    }

    // General authentication errors
    if (error.message.includes('E170001') ||
        error.message.includes('Authentication failed') ||
        error.message.includes('authorization failed')) {
      return {
        message: `${baseMessage}: Authentication error`,
        suggestion: 'Verify your SVN credentials (SVN_USERNAME and SVN_PASSWORD)'
      };
    }

    // Invalid working copy
    if (error.message.includes('E155007') ||
        error.message.includes('not a working copy')) {
      return {
        message: `${baseMessage}: Not a valid working copy`,
        suggestion: 'Make sure you are in an SVN checkout directory or run svn checkout first'
      };
    }

    // Working copy locked
    if (error.message.includes('E155036') ||
        error.message.includes('working copy locked')) {
      return {
        message: `${baseMessage}: Working copy locked`,
        suggestion: 'Run "svn cleanup" to unlock the working copy'
      };
    }

    // Generic exit code 1 (common with remote commands)
    if (error.code === 1) {
      return {
        message: `${baseMessage}: Command failed with exit code 1 (possible network/authentication issue)`,
        suggestion: 'Check network connectivity, SVN credentials, and that the repository is reachable'
      };
    }

    // Fallback
    return {
      message: `${baseMessage}: ${error.message}`,
      suggestion: undefined
    };
  }

  /**
   * Clear the SVN credentials cache to resolve authentication errors
   */
  async clearCredentials(): Promise<SvnResponse> {
    return await clearSvnCredentials(this.config);
  }

  /**
   * Show the contents of a versioned file (svn cat).
   * Accepts a local path or a repository URL.
   */
  async cat(target: string, options: SvnCatOptions = {}): Promise<SvnResponse<string>> {
    try {
      if (!target || typeof target !== 'string') {
        throw new SvnError('Target path or URL is required for svn cat');
      }

      // Whole-file inline: only when nobody asked for a file or a filter.
      if (!options.saveTo && !options.pattern) {
        const args = ['cat'];
        if (options.revision !== undefined && options.revision !== null && options.revision !== '') {
          args.push('--revision', String(options.revision));
        }
        args.push(resolveTarget(target, this.config).value);

        const response = await executeSvnCommand(this.config, args, {
          timeout: options.timeout ?? NETWORK_TIMEOUT_MS
        });

        return {
          success: true,
          data: cleanOutput(response.data as string),
          command: response.command,
          workingDirectory: response.workingDirectory,
          executionTime: response.executionTime
        };
      }

      const fetched = await this.fetchContent(target, options.revision, options.saveTo, options.timeout);
      const header =
        `${fetched.savedTo ? `Saved to: ${fetched.savedTo}\n` : ''}` +
        `Bytes: ${fetched.byteLength}\n` +
        `Encoding: ${fetched.encodingNote}\n`;

      let body: string;
      if (options.pattern) {
        const matches = matchLines(fetched.text, options.pattern, options.contextLines ?? 0);
        body = matches.length
          ? `Matching lines (${matches.length}):\n` +
            matches.map(m => `${m.line}: ${m.content}`).join('\n')
          : `No line matched /${options.pattern}/.`;
      } else {
        // saveTo without a pattern: the content is on disk on purpose, so the
        // answer stays small. Returning it here would defeat the point.
        body = 'Content written to disk; not included in this answer.';
      }

      if (!fetched.savedTo) fs.rmSync(fetched.tempPath!, { force: true });

      return {
        success: true,
        data: `${header}\n${body}`,
        command: fetched.command,
        workingDirectory: this.config.workingDirectory!,
        executionTime: fetched.executionTime
      };

    } catch (error: any) {
      this.handleSvnError(error, 'get file contents (svn cat)');
    }
  }

  /**
   * Materialize one versioned file and read it back as bytes.
   *
   * ⚠ Uses `svn export`, not `svn cat`, and that is the whole point: the command
   * pipeline decodes stdout as UTF-8, so a latin1 source file — which every web
   * file here is — comes back with every accented byte replaced by U+FFFD. Writing
   * that to disk would corrupt the file, silently. Measured on
   * `cfc_emissao_documentos.cfc`: 269 accented bytes became 807 (3 bytes per
   * replacement char) the one time I captured `svn cat` through a re-encoding
   * redirect. Letting svn write the file keeps the repository's exact bytes.
   */
  private async fetchContent(
    target: string,
    revision?: SvnCatOptions['revision'],
    saveTo?: string,
    timeout?: number
  ): Promise<{
    savedTo?: string;
    tempPath?: string;
    byteLength: number;
    encodingNote: string;
    text: string;
    command: string;
    executionTime?: number;
  }> {
    const destination = saveTo
      ? nodePath.resolve(saveTo)
      : nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'svncat-')), 'content');

    const args = ['export', '--force'];
    if (revision !== undefined && revision !== null && revision !== '') {
      args.push('--revision', String(revision));
    }
    args.push(resolveTarget(target, this.config).value, destination);

    const response = await executeSvnCommand(this.config, args, {
      timeout: timeout ?? NETWORK_TIMEOUT_MS
    });

    const bytes = fs.readFileSync(destination);
    const probe = describeEncoding(bytes);

    return {
      savedTo: saveTo ? destination : undefined,
      tempPath: saveTo ? undefined : destination,
      byteLength: bytes.length,
      encodingNote: probe.note,
      // Decode with what the bytes actually are, so a matched line comes back
      // readable instead of peppered with replacement characters.
      text: probe.isUtf8 ? bytes.toString('utf8') : bytes.toString('latin1'),
      command: response.command,
      executionTime: response.executionTime
    };
  }

  /**
   * Line-by-line authorship (svn blame).
   *
   * ⚠ Reads attribution from `--xml`, never from the plain form: the text output
   * pads the author into a fixed 10-character column, so `fioravante.manfron`
   * arrives as `fioravante` and `rodrigo.tenorio` as `rodrigo.te`. A truncated
   * username is worse than none — it looks like a real answer.
   *
   * The XML carries no line content, so the content comes from the file itself at
   * the same revision, and the two are joined by line number.
   */
  async blame(target: string, options: SvnBlameOptions = {}): Promise<SvnResponse<SvnBlameLine[]>> {
    try {
      if (!target || typeof target !== 'string') {
        throw new SvnError('Target path or URL is required for svn blame');
      }

      const args = ['blame', '--xml'];
      if (options.revision !== undefined && options.revision !== null && options.revision !== '') {
        args.push('--revision', String(options.revision));
      }
      args.push(resolveTarget(target, this.config).value);

      const response = await executeSvnCommand(this.config, args, {
        timeout: options.timeout ?? NETWORK_TIMEOUT_MS
      });

      const attribution = parseBlameOutput(response.data as string);
      const fetched = await this.fetchContent(target, options.revision, undefined, options.timeout);
      const lines = fetched.text.split(/\r?\n/);
      fs.rmSync(nodePath.dirname(fetched.tempPath!), { recursive: true, force: true });

      const wanted = (lineNumber: number, content: string): boolean => {
        if (options.pattern) return new RegExp(options.pattern).test(content);
        const from = options.startLine ?? 1;
        const to = options.endLine ?? Number.MAX_SAFE_INTEGER;
        return lineNumber >= from && lineNumber <= to;
      };

      const blamed: SvnBlameLine[] = [];
      for (const [lineNumber, meta] of attribution) {
        const content = lines[lineNumber - 1] ?? '';
        if (!wanted(lineNumber, content)) continue;
        blamed.push({
          lineNumber,
          revision: meta.revision,
          author: meta.author,
          date: meta.date ?? '',
          content
        });
      }

      return {
        success: true,
        data: blamed,
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      this.handleSvnError(error, 'get line authorship (svn blame)');
    }
  }

  /**
   * List entries of a versioned directory (svn list).
   * Accepts a local path or a repository URL. If no target is given, the working copy is used.
   */
  async list(
    target?: string,
    options: SvnListOptions = {}
  ): Promise<SvnResponse<{ entries: SvnListEntry[]; raw: string }>> {
    try {
      const args = ['list'];

      if (options.verbose) {
        args.push('--verbose');
      }

      if (options.depth) {
        args.push('--depth', options.depth);
      } else if (options.recursive) {
        args.push('--recursive');
      }

      if (options.includeExternals) {
        args.push('--include-externals');
      }

      if (options.revision !== undefined && options.revision !== null && options.revision !== '') {
        args.push('--revision', String(options.revision));
      }

      if (target) {
        args.push(resolveTarget(target, this.config).value);
      }

      const response = await executeSvnCommand(this.config, args);
      const raw = cleanOutput(response.data as string);
      const entries = parseListOutput(raw, !!options.verbose);

      return {
        success: true,
        data: { entries, raw },
        command: response.command,
        workingDirectory: response.workingDirectory,
        executionTime: response.executionTime
      };

    } catch (error: any) {
      this.handleSvnError(error, 'list directory (svn list)');
    }
  }
} 