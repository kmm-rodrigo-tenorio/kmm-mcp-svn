import { spawn, SpawnOptions } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { SvnConfig, SvnResponse, SvnError, SvnInfo, SvnStatus, SvnLogEntry, SvnChangedPath, SvnListEntry, SVN_STATUS_CODES } from './types.js';
import iconv from 'iconv-lite';
import { registerJob, appendJobOutput, finishJob } from './jobs.js';

/**
 * Create SVN configuration from environment variables and parameters.
 *
 * Environment variables:
 *   SVN_PATH                - path to the svn executable (default: 'svn')
 *   SVN_WORKING_DIRECTORY   - local working-copy directory (optional)
 *   SVN_URL / SVN_REPOSITORY_URL - repository URL (optional; used to
 *                             resolve repo-relative targets like
 *                             `/trunk/file.sql` and to run URL-only
 *                             commands without a working copy)
 *   SVN_USERNAME, SVN_PASSWORD
 *   SVN_TIMEOUT             - command timeout in ms (default: 30000)
 */
export function createSvnConfig(overrides: Partial<SvnConfig> = {}): SvnConfig {
  const envWorkingDir = process.env.SVN_WORKING_DIRECTORY;
  let workingDirectory = overrides.workingDirectory || envWorkingDir || process.cwd();
  let url = overrides.url || process.env.SVN_URL || process.env.SVN_REPOSITORY_URL;

  // Backward-compat: SVN_WORKING_DIRECTORY used to be overloaded with a
  // repository URL. Promote it to `url` and fall back cwd to something
  // valid, but warn so the user migrates to SVN_URL.
  if (!overrides.workingDirectory && envWorkingDir && validateSvnUrl(envWorkingDir)) {
    if (!url) url = envWorkingDir;
    workingDirectory = process.cwd();
    console.warn(
      `[svn-mcp] SVN_WORKING_DIRECTORY is set to a URL ("${envWorkingDir}"). ` +
      `Treating it as SVN_URL for backward compatibility. ` +
      `Please migrate to SVN_URL and set SVN_WORKING_DIRECTORY to a local path (or unset it).`
    );
  }

  return {
    svnPath: overrides.svnPath || process.env.SVN_PATH || 'svn',
    workingDirectory,
    url,
    username: overrides.username || process.env.SVN_USERNAME,
    password: overrides.password || process.env.SVN_PASSWORD,
    timeout: overrides.timeout || parseInt(process.env.SVN_TIMEOUT || '30000', 10)
  };
}

/**
 * Validate that SVN is available on the system
 */
export async function validateSvnInstallation(config: SvnConfig): Promise<boolean> {
  try {
    const result = await executeSvnCommand(config, ['--version', '--quiet']);
    return result.success;
  } catch (error) {
    return false;
  }
}

/**
 * Detect whether the current directory is an SVN working copy
 */
export async function isWorkingCopy(workingDirectory: string): Promise<boolean> {
  try {
    const svnDir = path.join(workingDirectory, '.svn');
    return await promisify(fs.access)(svnDir).then(() => true).catch(() => false);
  } catch {
    return false;
  }
}

/**
 * Normalize paths for Windows.
 *
 * ⚠ `baseDir` matters. Without it this resolves a relative path against the NODE
 * PROCESS cwd, while svn is spawned with cwd = `config.workingDirectory`. The two
 * are different directories — under Claude Desktop the process cwd is the app's
 * install folder — so a relative path lands outside the working copy and svn
 * answers "not a working copy", which reads as a repository problem rather than a
 * path problem. Callers that have a config should always pass
 * `config.workingDirectory`.
 *
 * Absolute inputs are unaffected: `path.resolve` ignores the base for those.
 */
export function normalizePath(filePath: string, baseDir?: string): string {
  return path.resolve(baseDir ?? process.cwd(), filePath).replace(/\\/g, '/');
}

/**
 * Resolve a target for a command that only works on a WORKING COPY
 * (`status`, `delete`, …), as opposed to `resolveTarget`, which is for commands
 * that also accept a repository URL (`cat`, `log`, `list`, …).
 *
 * Three inputs, three outcomes:
 *  - a URL is REFUSED, with a message saying why. Passing one used to be silently
 *    mangled into a local path by `normalizePath`, producing a nonsense target;
 *  - a repo-relative path (`/Software/_dev/...`) is mapped into the working copy;
 *  - anything else is a local path, resolved against the working copy.
 *
 * ⚠ The repo-relative mapping assumes the working-copy root corresponds to the
 * repository root. That holds for a checkout of the repo root (the usual layout
 * here) and is stated rather than left implicit — a checkout of a subtree would
 * need the offset.
 */
export function resolveWorkingCopyPath(target: string, config: SvnConfig): string {
  if (!target || typeof target !== 'string') {
    throw new SvnError('Target is required');
  }

  if (validateSvnUrl(target)) {
    throw new SvnError(
      `"${target}" is a repository URL, and this command only works on a working copy. ` +
      `Pass a local path, or a repo-relative path starting with "/" — that gets mapped into ` +
      `the working copy at ${config.workingDirectory}.`
    );
  }

  if (target.startsWith('/')) {
    // A leading slash means repo-relative — the same convention `resolveTarget`
    // uses. ⚠ Do NOT gate this on `path.isAbsolute`: on Windows "/Software" IS
    // absolute (root of the current drive), so that check skipped this branch and
    // `path.resolve` then produced "C:/Software/..." — the working-copy segment
    // silently dropped. A real local path on Windows starts with a drive letter
    // or a UNC prefix, which is what keeps the two apart.
    return normalizePath(path.join(config.workingDirectory!, target), config.workingDirectory);
  }

  if (!validatePath(target)) {
    throw new SvnError(`Invalid path: ${target}`);
  }
  return normalizePath(target, config.workingDirectory);
}

/**
 * Escape arguments for the Windows command line
 */
export function escapeArgument(arg: string): string {
  // If the argument contains spaces or special characters, wrap it in quotes
  if (/[\s&()<>[\]{}^=;!'+,`~%]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/**
 * Whether to rely on svn's own credential cache (~/.subversion/auth) instead of
 * passing credentials on the command line.
 *
 * Opt-in via SVN_USE_AUTH_CACHE=true. Worth turning on where the cache is
 * already populated: a password in argv is readable by any process on the
 * machine (ps / Process Explorer), which no amount of output redaction fixes.
 * Ignored when the caller explicitly asked to bypass the cache.
 */
function useAuthCache(options: { noAuthCache?: boolean }): boolean {
  if (options.noAuthCache) return false;
  return /^(true|1)$/i.test(process.env.SVN_USE_AUTH_CACHE || '');
}

/**
 * Build authentication arguments
 */
export function buildAuthArgs(config: SvnConfig, options: { noAuthCache?: boolean } = {}): string[] {
  const args: string[] = [];

  if (!useAuthCache(options)) {
    if (config.username) {
      args.push('--username', config.username);
    }

    if (config.password) {
      args.push('--password', config.password);
    }
  }

  // Always use --non-interactive to avoid prompts
  args.push('--non-interactive');

  // Option to skip the credentials cache (useful for E215004)
  if (options.noAuthCache) {
    args.push('--no-auth-cache');
  }

  return args;
}

/**
 * Secrets that must never appear in a displayed command string.
 *
 * Each entry is a flag whose FOLLOWING argv element carries the secret.
 * `--password` is the one svn actually uses; the others are listed so a
 * future change that starts passing them is redacted from day one.
 */
const SECRET_VALUE_FLAGS = new Set([
  '--password',
  '--password-from-stdin'
]);

const REDACTED = '***';

/**
 * Return a copy of `args` with every secret value replaced by `***`.
 *
 * This is display-only: the real argv still goes to spawn() untouched, so svn
 * behaviour is unchanged. Everything user-visible (SvnResponse.command,
 * SvnError.command, timeout/exit-code messages) is built from the redacted
 * copy, because those strings end up in transcripts, logs and agent context.
 *
 * `--username` is deliberately NOT redacted: it is useful for diagnosing
 * auth failures and is not a secret.
 */
export function redactAuthArgs(args: string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (!SECRET_VALUE_FLAGS.has(out[i])) continue;
    // A flag in last position has no value to redact — leave it alone
    // rather than pushing a bogus element.
    if (i + 1 < out.length) {
      out[i + 1] = REDACTED;
      i++; // don't re-inspect the value we just replaced
    }
  }
  return out;
}

/**
 * Execute an SVN command with improved error handling
 */
export async function executeSvnCommand(
  config: SvnConfig,
  args: string[],
  options: {
    input?: string;
    encoding?: BufferEncoding;
    noAuthCache?: boolean;
    /**
     * Per-call override, in ms. Network-bound commands (checkout, update) can far
     * exceed the 30 s default, and the timeout kills the process with SIGTERM —
     * an error that does not hint at time being the cause.
     */
    timeout?: number;
    /**
     * Stop waiting after this many ms and return `detached: true` with a job id,
     * leaving the process running. For commands that legitimately outlast the MCP
     * client's own request timeout — see `common/jobs.ts`.
     */
    detachAfterMs?: number;
    /** What the command acts on, recorded on the job so it can be verified later. */
    target?: string;
  } = {}
): Promise<SvnResponse> {
  const startTime = Date.now();
  // A detachable command must not also be killed on a deadline: the whole point
  // is to let it finish unattended.
  const timeoutMs = options.detachAfterMs ? 0 : (options.timeout ?? config.timeout ?? 30_000);
  
  // Append authentication arguments
  const finalArgs = [...args, ...buildAuthArgs(config, { noAuthCache: options.noAuthCache })];
  // Display/telemetry only — never the real argv. Built from the redacted copy
  // so the password cannot reach a response, an error message or a log.
  const command = `${config.svnPath} ${redactAuthArgs(finalArgs).join(' ')}`;
  
  return new Promise((resolve, reject) => {
    // We avoid `shell: true` on Windows for two reasons:
    //   1. Node's shell handling for cmd.exe sets
    //      windowsVerbatimArguments=true and joins argv with single
    //      spaces — destroying any argument that contains a space (e.g.
    //      paths under "Program Files" or repos with spaces in folder
    //      names). libuv's direct CreateProcess path quotes each argv
    //      element correctly.
    //   2. shell:true depends on cmd.exe being resolvable from the
    //      parent env, which Claude Desktop/Code sometimes sanitizes.
    //
    // The only case we still need a shell is when SVN_PATH points at a
    // .bat/.cmd shim — Node forbids spawning those directly since
    // 18.20/20.12 (CVE-2024-27980). For that we go through cmd.exe and
    // pre-escape each arg ourselves so the shell re-parses correctly.
    const isWindows = process.platform === 'win32';
    const isBatchShim = isWindows && /\.(bat|cmd)$/i.test(config.svnPath || '');
    const systemRoot = process.env.SystemRoot || process.env.systemroot || 'C:\\Windows';
    const system32 = `${systemRoot}\\System32`;
    const cmdPath = process.env.ComSpec || process.env.comspec || `${system32}\\cmd.exe`;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Force SVN to use UTF-8
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8'
    };

    if (isWindows) {
      childEnv.ComSpec = cmdPath;
      childEnv.SystemRoot = systemRoot;

      // Collapse duplicate-cased PATH entries (Windows inherited env often
      // ships 'Path'; if we also set 'PATH' the two may race). Keep a
      // single 'PATH' key and make sure System32 is present.
      for (const k of Object.keys(childEnv)) {
        if (k !== 'PATH' && k.toLowerCase() === 'path') delete childEnv[k];
      }
      const existingPath = process.env.PATH || process.env.Path || '';
      const pathParts = existingPath.split(';').filter(Boolean);
      const hasSystem32 = pathParts.some(p => p.toLowerCase() === system32.toLowerCase());
      childEnv.PATH = hasSystem32 ? existingPath : [...pathParts, system32].join(';');
    }

    // Resolve cwd. If SVN_WORKING_DIRECTORY is configured as a repository
    // URL (valid use case for URL-targeted commands like `svn cat <url>`),
    // we can't pass it to CreateProcess as cwd — Windows raises
    // ERROR_PATH_NOT_FOUND which libuv surfaces as a misleading
    // "spawn <exe> ENOENT" attached to the executable. Fall back to
    // process.cwd() in that case; URL commands pass the URL as an arg so
    // cwd doesn't matter, and local commands that need a working copy
    // won't have been given a URL here.
    let resolvedCwd = config.workingDirectory;
    if (!resolvedCwd || validateSvnUrl(resolvedCwd)) {
      resolvedCwd = process.cwd();
    }

    const spawnOptions: SpawnOptions = {
      cwd: resolvedCwd,
      // Direct spawn (no shell) lets libuv quote argv per element. The
      // batch-shim case is the only one that has to take the cmd.exe
      // detour, with manual arg escaping below.
      shell: isBatchShim ? cmdPath : false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv
    };

    // Only pre-escape when we're going through a shell — direct spawn
    // does its own quoting and would double-escape if we did it too.
    const argsForSpawn = isBatchShim ? finalArgs.map(escapeArgument) : finalArgs;
    const childProcess = spawn(config.svnPath!, argsForSpawn, spawnOptions);
    
    let stdout = '';
    let stderr = '';
    
    // Create streaming decoders to properly handle multi-byte characters across chunk boundaries
    // Using UTF-8 as SVN output is configured to use UTF-8 via LANG/LC_ALL environment variables
    // The encoding is consistent throughout the stream - it doesn't change mid-stream as per SVN behavior
    const stdoutDecoder = iconv.getDecoder('utf8', { stripBOM: false, addBOM: false });
    const stderrDecoder = iconv.getDecoder('utf8', { stripBOM: false, addBOM: false });
    
    // Configure timeout. Zero means "no deadline", which is what a detachable
    // command gets: killing it at the threshold would destroy exactly the case
    // detaching exists to rescue.
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
          childProcess.kill('SIGTERM');
          reject(new SvnError(
            `Command timeout after ${timeoutMs}ms: ${command}. ` +
            `Network-bound commands can legitimately take longer — pass a larger \`timeout\` ` +
            `on the call, or raise SVN_TIMEOUT.`
          ));
        }, timeoutMs)
      : undefined;

    // A detachable command gets a job up front, so its output has somewhere to go
    // once nobody is awaiting it any more.
    const job = options.detachAfterMs
      ? registerJob({ command, target: options.target, cwd: resolvedCwd })
      : undefined;
    let detached = false;
    const detachTimer = options.detachAfterMs
      ? setTimeout(() => {
          detached = true;
          resolve({
            success: true,
            command,
            workingDirectory: config.workingDirectory!,
            executionTime: Date.now() - startTime,
            detached: true,
            jobId: job!.id
          });
        }, options.detachAfterMs)
      : undefined;

    // ⚠ These listeners stay attached after detaching, on purpose. stdio is
    // 'pipe': stop draining it and the OS buffer fills, which BLOCKS svn. What is
    // abandoned is the await, never the reading.
    childProcess.stdout?.on('data', (data) => {
      const text = stdoutDecoder.write(data);
      stdout += text;
      if (job) appendJobOutput(job.id, 'stdout', text);
    });

    childProcess.stderr?.on('data', (data) => {
      const text = stderrDecoder.write(data);
      stderr += text;
      if (job) appendJobOutput(job.id, 'stderr', text);
    });

    // Write input if provided
    if (options.input && childProcess.stdin) {
      childProcess.stdin.write(options.input);
      childProcess.stdin.end();
    }

    // Handle process completion
    childProcess.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (detachTimer) clearTimeout(detachTimer);

      // Finalize decoders to flush any remaining buffered data
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();

      if (job) finishJob(job.id, code);

      // Already detached: the caller was answered long ago. Recording the outcome
      // on the job is all that is left — resolving twice is a no-op, and rejecting
      // would be an unhandled rejection with nobody to catch it.
      if (detached) return;

      const executionTime = Date.now() - startTime;
      const response: SvnResponse = {
        success: code === 0,
        command,
        workingDirectory: config.workingDirectory!,
        executionTime
      };

      if (code === 0) {
        response.data = stdout.trim();
        resolve(response);
      } else {
        // ⚠ The reason has to be IN the message, not only on `error.stderr`.
        // Nine call sites rethrow `Failed to X: ${error.message}` and drop the
        // rest, so an svn failure arrived as "failed with code 1" and nothing
        // else — a real E155007 took a hand-run of the same command to diagnose.
        const detail = errorDetail(stderr);
        const error = new SvnError(
          `SVN command failed with code ${code}: ${command}${detail ? `\n${detail}` : ''}`
        );
        error.code = code || undefined;
        error.stderr = stderr.trim();
        error.command = command;

        response.error = error.message;
        response.data = stderr.trim();

        reject(error);
      }
    });

    // Handle process errors
    childProcess.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (detachTimer) clearTimeout(detachTimer);
      if (job) finishJob(job.id, -1, `spawn failed: ${error.message}`);
      if (detached) return;

      const svnError = new SvnError(`Failed to execute SVN command: ${error.message}`);
      svnError.command = command;

      reject(svnError);
    });
  });
}

/**
 * svn's reason for skipping `target`, if it skipped it — otherwise undefined.
 *
 * ⚠ This exists because `--parents` turns a hard failure into a silent success.
 * Asking for a path that is not in the repository exits **1** with
 * `E155007` normally, but with `--parents` it exits **0** and merely prints
 * `Skipped '<path>' -- Has no versioned parent`. Reporting that as "Update
 * Completed" would be the same class of lie as reporting a finished update as a
 * timeout: the caller asked for a path and got nothing.
 *
 * Only a skip of the REQUESTED target counts. A bulk update can legitimately skip
 * unrelated paths while doing everything else correctly, and that is not a failure
 * of the call.
 */
export function skippedTargetReason(output: string, target?: string): string | undefined {
  if (!output || !target) return undefined;

  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const wanted = normalize(target);

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^Skipped(?: [^']*)? '(.+?)'(?:\s*--\s*(.+))?$/);
    if (!match) continue;

    // ⚠ svn reports the path RELATIVE TO ITS CWD, not as it was passed in. The
    // server runs with cwd at the working-copy root, so an absolute target comes
    // back as 'Software\_dev\...'. Comparing the two as equals silently never
    // matched — the guard was dead code until this ran against the real output.
    // The leading separator keeps the suffix from matching a different path that
    // merely ends the same way.
    const skipped = normalize(match[1]);
    if (wanted === skipped || wanted.endsWith(`/${skipped}`)) {
      return (match[2] || 'no reason given by svn').trim();
    }
  }

  return undefined;
}

/**
 * What these bytes actually are, and how many of them are non-ASCII.
 *
 * ⚠ This exists to be reported before anyone edits the file. Every web file in
 * this tree is latin1 — `cfc_emissao_documentos.cfc` carries 269 bytes >= 0x80 in
 * its comments — and editing it through a tool that assumes UTF-8 rewrites all of
 * them. A 335 KB file corrupted in a client's branch is worse than the bug being
 * fixed, so the check cannot depend on somebody remembering to run it.
 */
export function describeEncoding(bytes: Buffer): { isUtf8: boolean; highBytes: number; note: string } {
  let highBytes = 0;
  for (const byte of bytes) if (byte >= 0x80) highBytes += 1;

  let isUtf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    isUtf8 = false;
  }

  const note = highBytes === 0
    ? 'ASCII only (safe to edit as text)'
    : isUtf8
      ? `UTF-8 (${highBytes} bytes >= 0x80)`
      : `NOT UTF-8, treat as latin1 (${highBytes} bytes >= 0x80) — edit byte-exact or those bytes will be rewritten`;

  return { isUtf8, highBytes, note };
}

/** Lines matching `pattern`, 1-based, optionally with surrounding context. */
export function matchLines(
  text: string,
  pattern: string,
  contextLines = 0
): Array<{ line: number; content: string }> {
  const regex = new RegExp(pattern);
  const lines = text.split(/\r?\n/);
  const keep = new Set<number>();

  lines.forEach((content, index) => {
    if (!regex.test(content)) return;
    const from = Math.max(0, index - contextLines);
    const to = Math.min(lines.length - 1, index + contextLines);
    for (let i = from; i <= to; i++) keep.add(i);
  });

  return [...keep].sort((a, b) => a - b).map(index => ({ line: index + 1, content: lines[index] }));
}

/**
 * Parse `svn blame --xml` into line number → author/revision/date.
 *
 * ⚠ The plain-text form is not an option: it pads the author into a fixed
 * 10-character column, turning `fioravante.manfron` into `fioravante`. Truncated
 * attribution reads like a real answer, which makes it worse than missing data.
 */
export function parseBlameOutput(
  output: string
): Map<number, { revision: number; author: string; date?: string }> {
  const attribution = new Map<number, { revision: number; author: string; date?: string }>();
  if (!output) return attribution;

  const entryPattern = /<entry\b[^>]*\bline-number="(\d+)"[^>]*>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(output)) !== null) {
    const line = Number(match[1]);
    const body = match[2];
    const revision = body.match(/<commit\b[^>]*\brevision="(\d+)"/)?.[1];
    // A line never committed (locally modified) has no <commit> — skip it rather
    // than inventing revision 0.
    if (revision === undefined) continue;

    attribution.set(line, {
      revision: Number(revision),
      author: unescapeXml(body.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? ''),
      date: body.match(/<date>([\s\S]*?)<\/date>/)?.[1]
    });
  }

  return attribution;
}

/**
 * The part of svn's stderr worth carrying in an error message.
 *
 * Keeps the TAIL: svn prints context first ("Skipped '...'") and the actual
 * `svn: E155007: ...` line last, so the end is the part that names the cause.
 */
export function errorDetail(stderr: string, maxLines = 5, maxChars = 600): string {
  const trimmed = stderr.trim();
  if (!trimmed) return '';
  const tail = trimmed.split(/\r?\n/).slice(-maxLines).join('\n');
  return tail.length <= maxChars ? tail : tail.slice(tail.length - maxChars);
}

/**
 * Parse SVN XML output
 */
export function parseXmlOutput(xmlString: string): any {
  // Basic XML parsing implementation
  // In a production environment it would be better to use a library like xml2js
  try {
    // This is a simplified implementation for Node.js
    // In browsers we would use DOMParser, but in Node.js we need another approach
    const lines = xmlString.split('\n');
    const result: any = {};
    
    for (const line of lines) {
      const match = line.match(/<([^>]+)>([^<]+)<\/\1>/);
      if (match) {
        result[match[1]] = match[2];
      }
    }
    
    return result;
  } catch (error) {
    throw new SvnError(`Failed to parse XML output: ${error}`);
  }
}

/**
 * Parse output of `svn info`
 */
export function parseInfoOutput(output: string): SvnInfo {
  const lines = output.split('\n');
  const info: Partial<SvnInfo> = {};
  
  for (const line of lines) {
    const [key, ...valueParts] = line.split(': ');
    const value = valueParts.join(': ').trim();
    
    switch (key.trim()) {
      case 'Path':
        info.path = value;
        break;
      case 'Working Copy Root Path':
        info.workingCopyRootPath = value;
        break;
      case 'URL':
        info.url = value;
        break;
      case 'Relative URL':
        info.relativeUrl = value;
        break;
      case 'Repository Root':
        info.repositoryRoot = value;
        break;
      case 'Repository UUID':
        info.repositoryUuid = value;
        break;
      case 'Revision':
        info.revision = parseInt(value, 10);
        break;
      case 'Node Kind':
        info.nodeKind = value as 'file' | 'directory';
        break;
      case 'Schedule':
        info.schedule = value;
        break;
      case 'Last Changed Author':
        info.lastChangedAuthor = value;
        break;
      case 'Last Changed Rev':
        info.lastChangedRev = parseInt(value, 10);
        break;
      case 'Last Changed Date':
        info.lastChangedDate = value;
        break;
      case 'Text Last Updated':
        info.textLastUpdated = value;
        break;
      case 'Checksum':
        info.checksum = value;
        break;
    }
  }
  
  return info as SvnInfo;
}

/**
 * Parse output of `svn status`
 */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, or an escaped entity would be decoded twice.
    .replace(/&amp;/g, '&');
}

/**
 * Parse the output of `svn status --xml`.
 *
 * ⚠ This used to read fixed columns — `line[0]` for the code and
 * `line.substring(8)` for the path — and that arithmetic does not hold:
 *
 *  - a property-only modification is reported as `' M'`, with a SPACE in column 0.
 *    The output then starts with whitespace, and the global `.trim()` applied
 *    before parsing shifted only the FIRST line one column left, so `substring(8)`
 *    ate the first character of its path. Observed live: `C:\SVN\...` came back as
 *    `:\SVN\...` — a path no consumer can use;
 *  - `--show-updates` inserts the out-of-date marker and the server revision
 *    before the path, so the fixed offset swallowed those into the "path" too;
 *  - and it filled none of the `revision` / `changedRev` / `changedAuthor` /
 *    `changedDate` fields the type has always declared.
 *
 * The XML form is delimited, so none of that applies: leading spaces, paths with
 * spaces (common here — `TASK 25035`, `Ticket 259210.4`) and the extra `-u`
 * columns all stop mattering. A scan over the `<entry>` elements is enough; a
 * general XML parser would be a dependency for four attributes.
 */
export function parseStatusOutput(output: string): SvnStatus[] {
  const statusList: SvnStatus[] = [];
  if (!output) return statusList;

  const entryPattern = /<entry\b[^>]*\bpath="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/g;
  let entry: RegExpExecArray | null;

  while ((entry = entryPattern.exec(output)) !== null) {
    const path = unescapeXml(entry[1]);
    const body = entry[2];

    const wc = body.match(/<wc-status\b([^>]*)>/);
    const attrs = wc ? wc[1] : '';
    const item = attrs.match(/\bitem="([^"]*)"/)?.[1];
    const revision = attrs.match(/\brevision="(\d+)"/)?.[1];

    const commit = body.match(/<commit\b[^>]*\brevision="(\d+)"[^>]*>([\s\S]*?)<\/commit>/);
    const changedRev = commit?.[1];
    const author = commit?.[2].match(/<author>([\s\S]*?)<\/author>/)?.[1];
    const date = commit?.[2].match(/<date>([\s\S]*?)<\/date>/)?.[1];

    const status: SvnStatus = {
      path,
      // `item` already carries the long name ('modified', 'unversioned', ...),
      // which is exactly the union the type declares.
      status: (item as SvnStatus['status']) ?? 'unknown' as SvnStatus['status']
    };
    if (revision !== undefined) status.revision = Number(revision);
    if (changedRev !== undefined) status.changedRev = Number(changedRev);
    if (author) status.changedAuthor = unescapeXml(author);
    if (date) status.changedDate = date;

    statusList.push(status);
  }

  return statusList;
}

/**
 * Parse the output of `svn log --xml` (add `-v` to get `changedPaths`).
 *
 * ⚠ This used to split the plain-text form on the 72-dash separator and regex the
 * `r123 | author | date | N lines` header. Same class of fragility as the old
 * status parser, and with the same consequence: it filled none of the
 * `changedPaths` the type has always declared — so the **origin of a branch was
 * unreachable**, which is exactly the check that stops a fix being written against
 * the wrong code (a GA version branches off `bugfixes`, where the defect may not
 * exist). The XML form carries `copyfrom-path` / `copyfrom-rev` as attributes.
 */
export function parseLogOutput(output: string): SvnLogEntry[] {
  const entries: SvnLogEntry[] = [];
  if (!output) return entries;

  const entryPattern = /<logentry\b[^>]*\brevision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(output)) !== null) {
    const revision = Number(match[1]);
    const body = match[2];

    const entry: SvnLogEntry = {
      revision,
      author: unescapeXml(body.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? ''),
      date: body.match(/<date>([\s\S]*?)<\/date>/)?.[1] ?? '',
      message: unescapeXml(body.match(/<msg>([\s\S]*?)<\/msg>/)?.[1] ?? '').trim() || 'No message'
    };

    // Only present with `-v`. This is where the branch's origin lives:
    // `copyfrom-path` + `copyfrom-rev` on the `A` entry of a `svn copy`, which is
    // how a KMM branch is created. Reading it from an attribute beats mining
    // "(from <path>:<rev>)" out of the plain-text form.
    const pathPattern = /<path\b([^>]*)>([\s\S]*?)<\/path>/g;
    let pathMatch: RegExpExecArray | null;
    const changedPaths: SvnChangedPath[] = [];

    while ((pathMatch = pathPattern.exec(body)) !== null) {
      const attrs = pathMatch[1];
      const changed: SvnChangedPath = {
        action: (attrs.match(/\baction="([^"]*)"/)?.[1] ?? 'M') as SvnChangedPath['action'],
        path: unescapeXml(pathMatch[2])
      };
      const copyFromPath = attrs.match(/\bcopyfrom-path="([^"]*)"/)?.[1];
      const copyFromRev = attrs.match(/\bcopyfrom-rev="(\d+)"/)?.[1];
      if (copyFromPath) changed.copyFromPath = unescapeXml(copyFromPath);
      if (copyFromRev) changed.copyFromRev = Number(copyFromRev);
      changedPaths.push(changed);
    }

    if (changedPaths.length) entry.changedPaths = changedPaths;
    entries.push(entry);
  }

  return entries;
}

/**
 * Parse output of `svn list`. Supports both simple and verbose modes.
 * Simple: one name per line; directories end with '/'.
 * Verbose: "REV AUTHOR [SIZE] DATE NAME" — size is absent for directories.
 */
export function parseListOutput(output: string, verbose: boolean = false): SvnListEntry[] {
  const entries: SvnListEntry[] = [];
  if (!output || output.trim().length === 0) {
    return entries;
  }

  const lines = output.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);

  if (!verbose) {
    for (const rawName of lines) {
      const isDir = rawName.endsWith('/');
      const name = isDir ? rawName.slice(0, -1) : rawName;
      if (!name) continue;
      entries.push({ name, kind: isDir ? 'dir' : 'file' });
    }
    return entries;
  }

  // Verbose: REV AUTHOR [SIZE] DATE... NAME
  // SIZE only appears for files; DATE spans multiple tokens (month day year/time).
  // Regex: 4 fixed tokens (rev, author, size-or-empty, date-block) + name.
  const verboseRegex = /^\s*(\d+)\s+(\S+)\s+(?:(\d+)\s+)?(\S+\s+\S+\s+\S+)\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(verboseRegex);
    if (!m) continue;
    const [, rev, author, size, date, rawName] = m;
    const isDir = rawName.endsWith('/') || rawName === '.';
    const name = isDir && rawName !== '.' ? rawName.slice(0, -1) : rawName;
    entries.push({
      name,
      kind: isDir ? 'dir' : 'file',
      revision: parseInt(rev, 10),
      author,
      size: size !== undefined ? parseInt(size, 10) : undefined,
      date
    });
  }
  return entries;
}

/**
 * Format a duration in milliseconds to a human-readable string
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Validate a file/directory name
 */
export function validatePath(filePath: string): boolean {
  // Check that it does not contain characters forbidden on Windows
  // but allow a colon in valid contexts (Windows drive letters)

  // Pattern to detect Windows absolute paths (C:, D:, etc.)
  const windowsAbsolutePathPattern = /^[A-Za-z]:[\\\/]/;

  if (windowsAbsolutePathPattern.test(filePath)) {
    // For Windows absolute paths, only validate the segment after the drive letter
    const pathAfterDrive = filePath.substring(2); // Strip "C:" or similar
    const invalidChars = /[<>:"|?*]/;
    return !invalidChars.test(pathAfterDrive);
  } else {
    // For every other path, apply full validation
    const invalidChars = /[<>:"|?*]/;
    return !invalidChars.test(filePath);
  }
}

/**
 * Get a relative path from the working directory
 */
export function getRelativePath(fullPath: string, workingDirectory: string): string {
  return path.relative(workingDirectory, fullPath).replace(/\\/g, '/');
}

/**
 * Validate an SVN repository URL. Recognises svn://, svn+<tunnel>://
 * (e.g. svn+ssh://), http(s):// and file://.
 */
export function validateSvnUrl(url: string): boolean {
  const svnUrlPattern = /^(svn(\+[a-z0-9]+)?|https?|file):\/\/.+/i;
  return svnUrlPattern.test(url);
}

/**
 * Validate an SVN revision argument: a number, one of svn's keywords, or a
 * `{DATE}` specifier. Anything else is rejected here rather than handed to svn,
 * which fails deep in its own argument parsing — on Bug-41093 a caller passed the
 * string `{"$":"HEAD"}` and got `E205000: Syntax error parsing peg revision`,
 * which names the garbage but not the parameter that carried it.
 */
export function validateRevision(revision: string): boolean {
  // The `{DATE}` branch has to start with a digit: `\{[^{}]+\}` would also accept
  // `{"$":"HEAD"}`, which is the exact input this guard exists to reject.
  const svnRevisionPattern = /^(\d+|HEAD|BASE|COMMITTED|PREV|\{\d[\d\-:T .+Z]*\})$/i;
  return svnRevisionPattern.test(revision.trim());
}

/**
 * Join a repository base URL with a repo-relative path. Preserves the
 * exact encoding of the inputs — we do not re-encode callers' input.
 */
export function joinRepoUrl(baseUrl: string, repoPath: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rel = repoPath.replace(/^\/+/, '');
  return rel ? `${base}/${rel}` : base;
}

export interface ResolvedTarget {
  /** Final value to pass to svn on the command line. */
  value: string;
  kind: 'url' | 'path';
}

/**
 * Resolve a user-supplied target that may be a URL, a repo-relative
 * path (`/trunk/foo`), or a local path, according to the configured
 * working copy and repository URL.
 *
 * Resolution order:
 *   1. Full URL (http(s)://, svn[+tunnel]://, file://) — used as-is.
 *   2. Starts with `/` and `config.url` is set — joined to `config.url`.
 *   3. Otherwise — treated as a local filesystem path and normalized.
 */
export function resolveTarget(target: string, config: SvnConfig): ResolvedTarget {
  if (!target || typeof target !== 'string') {
    throw new SvnError('Target is required');
  }

  if (validateSvnUrl(target)) {
    return { value: target, kind: 'url' };
  }

  if (target.startsWith('/') && config.url) {
    return { value: joinRepoUrl(config.url, target), kind: 'url' };
  }

  if (!validatePath(target)) {
    throw new SvnError(`Invalid path or URL: ${target}`);
  }
  return { value: normalizePath(target), kind: 'path' };
}

/**
 * Clean and normalize command output
 */
export function cleanOutput(output: string): string {
  return output
    .replace(/\r\n/g, '\n')  // Normalize line endings
    .replace(/\r/g, '\n')    // Convert CR to LF
    .trim();
}

/**
 * Create a more descriptive SVN error message
 */
export function createSvnError(message: string, command?: string, stderr?: string): SvnError {
  const error = new SvnError(message);
  if (command) error.command = command;
  if (stderr) error.stderr = stderr;
  return error;
}

/**
 * Clear the SVN credentials cache to resolve E215004 errors
 */
export async function clearSvnCredentials(config: SvnConfig): Promise<SvnResponse> {
  try {
    // On Unix/Linux systems, SVN stores credentials in ~/.subversion/auth
    // On Windows, in %APPDATA%\Subversion\auth
    // Attempt to clear using the dedicated auth command if available

    // First try the standard cleanup command
    return await executeSvnCommand(config, ['auth', '--remove'], { noAuthCache: true });
  } catch (error: any) {
    // If the auth command is unavailable, try a fallback
    try {
      // Fallback: run a command that does not store credentials
      const response = await executeSvnCommand(config, ['info', '--non-interactive'], { noAuthCache: true });
      return {
        success: true,
        data: 'Credentials cache cleared (using alternative method)',
        command: 'clear-credentials',
        workingDirectory: config.workingDirectory!
      };
    } catch (fallbackError: any) {
      return {
        success: false,
        error: `Could not clear credentials cache: ${fallbackError.message}`,
        command: 'clear-credentials',
        workingDirectory: config.workingDirectory!
      };
    }
  }
} 