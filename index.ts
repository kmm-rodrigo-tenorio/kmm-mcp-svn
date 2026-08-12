#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Import SVN service
import { SvnService, DETACH_AFTER_MS } from "./tools/svn-service.js";
import { formatDuration } from "./common/utils.js";
import { getJob, listJobs, SvnJob } from "./common/jobs.js";

import { VERSION } from "./common/version.js";

// Create the MCP Server with proper configuration
/**
 * What a caller sees when a command outlasted its threshold.
 *
 * The wording is the point. This same situation previously surfaced as
 * `MCP error -32001: Request timed out` on an operation that had in fact
 * SUCCEEDED — 52.5 MB fetched, working copy intact. An agent reading a timeout
 * retries, and a second svn on the same working copy fights the first for its
 * lock. So the message has to say, in this order: not an error, the job id, the
 * target, and that verification is `svn_info` on the target rather than repeating
 * the command.
 */
function detachedNotice(opts: { jobId?: string; target?: string; what: string }): string {
  return `⏳ **${opts.what} is still running — this is NOT an error and NOT a failure.**

` +
    `**Job:** \`${opts.jobId ?? '(unknown)'}\`
` +
    (opts.target ? `**Target:** \`${opts.target}\`
` : '') +
    `
It outlasted the ${Math.round(DETACH_AFTER_MS / 1000)}s threshold, so the answer came back ` +
    `before the work finished. The process was left running — nothing was cancelled.

` +
    `Next: \`svn_job_status\` with that job id to see whether it finished, then confirm the effect ` +
    `with \`svn_info\` on the target. **Do not repeat the command** — a second svn on the same ` +
    `working copy contends for its lock.`;
}

const server = new McpServer({
  name: "svn-mcp-server",
  version: VERSION,
});

// Create SVN service instance (lazy initialization)
let svnService: SvnService | null = null;

function getSvnService(): SvnService {
  if (!svnService) {
    try {
      svnService = new SvnService();
    } catch (error: any) {
      throw new Error(`SVN configuration error: ${error.message}`);
    }
  }
  return svnService;
}

// ----- MCP TOOLS FOR SUBVERSION (SVN) -----

// 1. SVN system health check
server.tool(
  "svn_health_check",
  "Check the health status of the SVN system and working copy",
  {},
  async () => {
    try {
      const result = await getSvnService().healthCheck();

      const data = result.data;
      const statusIcon = data?.svnAvailable ? '✅' : '❌';
      const wcIcon = data?.workingCopyValid ? '📁' : '📂';
      const repoIcon = data?.repositoryAccessible ? '🔗' : '🔌';

      const healthText = `${statusIcon} **SVN System Status**\n\n` +
        `**SVN Available:** ${data?.svnAvailable ? 'Yes' : 'No'}\n` +
        `**Version:** ${data?.version || 'N/A'}\n` +
        `${wcIcon} **Working Copy Valid:** ${data?.workingCopyValid ? 'Yes' : 'No'}\n` +
        `${repoIcon} **Repository Accessible:** ${data?.repositoryAccessible ? 'Yes' : 'No'}\n` +
        `**Working Directory:** ${result.workingDirectory}`;

      return {
        content: [{ type: "text", text: healthText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 1.1. Advanced SVN command diagnostics
server.tool(
  "svn_diagnose",
  "Diagnose specific problems with SVN commands",
  {},
  async () => {
    try {
      const result = await getSvnService().diagnoseCommands();
      const data = result.data!;

      const statusLocalIcon = data.statusLocal ? '✅' : '❌';
      const statusRemoteIcon = data.statusRemote ? '✅' : '❌';
      const logIcon = data.logBasic ? '✅' : '❌';

      let diagnosticText = `🔍 **SVN Command Diagnostics**\n\n` +
        `**Working Directory:** ${data.workingCopyPath}\n\n` +
        `${statusLocalIcon} **Local Status:** ${data.statusLocal ? 'Working' : 'Failed'}\n` +
        `${statusRemoteIcon} **Remote Status:** ${data.statusRemote ? 'Working' : 'Failed'}\n` +
        `${logIcon} **Basic Log:** ${data.logBasic ? 'Working' : 'Failed'}\n`;

      if (data.errors.length > 0) {
        diagnosticText += `\n**Detected Errors:**\n`;
        data.errors.forEach((error, index) => {
          diagnosticText += `${index + 1}. ${error}\n`;
        });
      }

      if (!data.statusRemote || !data.logBasic) {
        diagnosticText += `\n**Possible Solutions:**\n`;
        diagnosticText += `• Check internet connectivity\n`;
        diagnosticText += `• Verify SVN credentials\n`;
        diagnosticText += `• Run 'svn cleanup' if there are lock issues\n`;
        diagnosticText += `• Make sure the working copy is up to date\n`;
      }

      return {
        content: [{ type: "text", text: diagnosticText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Diagnostic Error:** ${error.message}` }],
      };
    }
  }
);

// 2. Get repository information
server.tool(
  "svn_info",
  "Get detailed information about the working copy or a specific file. The path may be a local path, a repository URL, or a repo-relative path starting with '/' (joined with SVN_URL when configured).",
  {
    path: z.string().optional().describe("Local path, full URL, or repo-relative path like '/trunk/foo'")
  },
  async (args) => {
    try {
      const result = await getSvnService().getInfo(args.path);
      const info = result.data!;

      const infoText = `📋 **SVN Info**\n\n` +
        `**Path:** ${info.path}\n` +
        `**URL:** ${info.url}\n` +
        `**Relative URL:** ${info.relativeUrl}\n` +
        `**Repository Root:** ${info.repositoryRoot}\n` +
        `**UUID:** ${info.repositoryUuid}\n` +
        `**Revision:** ${info.revision}\n` +
        `**Node Kind:** ${info.nodeKind}\n` +
        `**Last Author:** ${info.lastChangedAuthor}\n` +
        `**Last Changed Revision:** ${info.lastChangedRev}\n` +
        `**Last Changed Date:** ${info.lastChangedDate}\n` +
        `**Working Copy Root:** ${info.workingCopyRootPath}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}`;

      return {
        content: [{ type: "text", text: infoText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 3. Get file status
server.tool(
  "svn_status",
  "Show the status of files in the working copy. Accepts a local path or a repo-relative path " +
  "(\"/Software/...\"), which is mapped into the working copy. A repository URL is refused — status " +
  "is a working-copy command.",
  {
    path: z.string().optional().describe("Path to query — local, or repo-relative starting with \"/\". Omit and the whole working copy is scanned."),
    showAll: z.boolean().optional().default(false).describe("Also show remote status")
  },
  async (args) => {
    try {
      const result = await getSvnService().getStatus(args.path, args.showAll);
      const statusList = result.data!;

      if (statusList.length === 0) {
        return {
          content: [{ type: "text", text: "✅ **No changes in the working copy**" }],
        };
      }

      const statusText = `📊 **SVN Status** (${statusList.length} items)\n\n` +
        statusList.map(status => {
          const statusIcon: {[key: string]: string} = {
            'added': '➕',
            'deleted': '➖',
            'modified': '✏️',
            'replaced': '🔄',
            'merged': '🔀',
            'conflicted': '⚠️',
            'ignored': '🙈',
            'none': '⚪',
            'normal': '✅',
            'external': '🔗',
            'incomplete': '⏸️',
            'unversioned': '❓',
            'missing': '❌'
          };

          return `${statusIcon[status.status] || '📄'} **${status.status.toUpperCase()}** - ${status.path}`;
        }).join('\n') +
        `\n\n**Execution Time:** ${formatDuration(result.executionTime || 0)}`;

      return {
        content: [{ type: "text", text: statusText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 4. Get change history
server.tool(
  "svn_log",
  "Show the commit history of the repository. The path may be a local path, a repository URL, or a repo-relative path starting with '/' (joined with SVN_URL when configured).",
  {
    path: z.string().optional().describe("Local path, full URL, or repo-relative path like '/trunk/foo'"),
    limit: z.number().optional().default(10).describe("Maximum number of entries"),
    revision: z.string().optional().describe("Specific revision or range (e.g. 100:200)")
  },
  async (args) => {
    try {
      const result = await getSvnService().getLog(args.path, args.limit, args.revision);
      const logEntries = result.data!;

      if (logEntries.length === 0) {
        return {
          content: [{ type: "text", text: "📝 **No log entries found**" }],
        };
      }

      const logText = `📚 **SVN History** (${logEntries.length} entries)\n\n` +
        logEntries.map((entry, index) =>
          `**${index + 1}. Revision ${entry.revision}**\n` +
          `👤 **Author:** ${entry.author}\n` +
          `📅 **Date:** ${entry.date}\n` +
          `💬 **Message:** ${entry.message || 'No message'}\n` +
          `---`
        ).join('\n\n') +
        `\n**Execution Time:** ${formatDuration(result.executionTime || 0)}`;

      return {
        content: [{ type: "text", text: logText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 5. View differences
server.tool(
  "svn_diff",
  "Show differences between file revisions. The path may be a local path, a repository URL, or a repo-relative path starting with '/' (joined with SVN_URL when configured).",
  {
    path: z.string().optional().describe("Local path, full URL, or repo-relative path like '/trunk/foo'"),
    oldRevision: z.string().optional().describe("Old revision"),
    newRevision: z.string().optional().describe("New revision")
  },
  async (args) => {
    try {
      const result = await getSvnService().getDiff(args.path, args.oldRevision, args.newRevision);
      const diffOutput = result.data!;

      if (!diffOutput || diffOutput.trim().length === 0) {
        return {
          content: [{ type: "text", text: "✅ **No differences found**" }],
        };
      }

      const diffText = `🔍 **SVN Diff**\n\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `\`\`\`diff\n${diffOutput}\n\`\`\``;

      return {
        content: [{ type: "text", text: diffText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 6. Repository checkout
server.tool(
  "svn_checkout",
  "Check out an SVN repository",
  {
    url: z.string().describe("SVN repository URL"),
    path: z.string().optional().describe("Destination directory"),
    revision: z.union([z.number(), z.literal("HEAD")]).optional().describe("Specific revision"),
    depth: z.enum(["empty", "files", "immediates", "infinity"]).optional().describe("Checkout depth"),
    force: z.boolean().optional().default(false).describe("Force checkout"),
    ignoreExternals: z.boolean().optional().default(false).describe("Ignore externals"),
    timeout: z.number().int().positive().optional().describe("Per-call timeout in ms. Defaults to 300000 for this command — checking out a real module branch over the network routinely needs more than the global 30s.")
  },
  async (args) => {
    try {
      const options = {
        revision: args.revision,
        depth: args.depth,
        force: args.force,
        ignoreExternals: args.ignoreExternals,
        timeout: args.timeout
      };

      const result = await getSvnService().checkout(args.url, args.path, options);

      if (result.detached) {
        return {
          content: [{ type: "text", text: detachedNotice({
            jobId: result.jobId, target: args.path ?? args.url, what: 'Checkout'
          }) }],
        };
      }

      const checkoutText = `📥 **Checkout Completed**\n\n` +
        `**URL:** ${args.url}\n` +
        `**Destination:** ${args.path || 'Current directory'}\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\``;

      return {
        content: [{ type: "text", text: checkoutText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 7. Update working copy
server.tool(
  "svn_update",
  "Update the working copy from the repository. Accepts a local path or a repo-relative path " +
  "(\"/Software/...\"), and `setDepth` to pull just one folder or one file into an otherwise sparse " +
  "working copy — which is how you fetch a single module branch instead of every branch of that module.",
  {
    path: z.string().optional().describe("Path to update — local, or repo-relative starting with \"/\". Omit and the ENTIRE working copy is updated."),
    revision: z.union([z.number(), z.literal("HEAD"), z.literal("BASE"), z.literal("COMMITTED"), z.literal("PREV")]).optional().describe("Target revision"),
    force: z.boolean().optional().default(false).describe("Force update"),
    ignoreExternals: z.boolean().optional().default(false).describe("Ignore externals"),
    acceptConflicts: z.enum(["postpone", "base", "mine-conflict", "theirs-conflict", "mine-full", "theirs-full"]).optional().describe("How to handle conflicts"),
    depth: z.enum(["empty", "files", "immediates", "infinity"]).optional().describe("Depth for this update only, without recording it."),
    setDepth: z.enum(["empty", "files", "immediates", "infinity", "exclude"]).optional().describe("Record a new depth for this path: `infinity` pulls the whole subtree in, `exclude` drops it. Prefer the SMALLEST path that answers your question — an entire module branch is large (measured: 2376 files, 52.8 MB, and it detaches), while `Oracle/Objetos/Funcoes` alone finishes in ~2s, and ONE FILE is instant: point `path` straight at the file with `setDepth: 'infinity'`. Missing intermediate directories are created by svn itself (`--parents`, always passed), so a deep path into a branch that was never checked out works on the first call — measured: one file out of an absent branch in ~1s."),
    timeout: z.number().int().positive().optional().describe("Per-call timeout in ms. Defaults to 300000 for this command.")
  },
  async (args) => {
    try {
      const options = {
        revision: args.revision,
        force: args.force,
        ignoreExternals: args.ignoreExternals,
        acceptConflicts: args.acceptConflicts,
        depth: args.depth,
        setDepth: args.setDepth,
        timeout: args.timeout
      };

      const result = await getSvnService().update(args.path, options);

      if (result.detached) {
        return {
          content: [{ type: "text", text: detachedNotice({
            jobId: result.jobId, target: args.path, what: 'Update'
          }) }],
        };
      }

      const updateText = `🔄 **Update Completed**\n\n` +
        `**Path:** ${args.path || 'Current directory'}\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\``;

      return {
        content: [{ type: "text", text: updateText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 8. Add files
server.tool(
  "svn_add",
  "Add files to version control",
  {
    paths: z.union([z.string(), z.array(z.string())]).describe("File(s) or director(y|ies) to add"),
    force: z.boolean().optional().default(false).describe("Force addition"),
    noIgnore: z.boolean().optional().default(false).describe("Do not honor ignore rules"),
    parents: z.boolean().optional().default(false).describe("Create parent directories if needed"),
    autoProps: z.boolean().optional().describe("Apply auto-props"),
    noAutoProps: z.boolean().optional().describe("Do not apply auto-props")
  },
  async (args) => {
    try {
      const options = {
        force: args.force,
        noIgnore: args.noIgnore,
        parents: args.parents,
        autoProps: args.autoProps,
        noAutoProps: args.noAutoProps
      };

      const result = await getSvnService().add(args.paths, options);
      const pathsArray = Array.isArray(args.paths) ? args.paths : [args.paths];

      const addText = `➕ **Files Added**\n\n` +
        `**Files:** ${pathsArray.join(', ')}\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\``;

      return {
        content: [{ type: "text", text: addText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 9. Commit changes
server.tool(
  "svn_commit",
  "Commit changes to the repository. TWO STEPS: the first call previews what would be committed and " +
  "writes nothing; a second call with `confirm: true` performs it. `paths` is required — a commit with " +
  "no explicit targets sweeps every modified file under the working-copy root into one revision.",
  {
    message: z.string().describe("Commit message"),
    paths: z.array(z.string()).min(1).describe("The files to commit. REQUIRED: without it svn commits everything modified under the working-copy root."),
    confirm: z.boolean().optional().default(false).describe("Must be true to actually commit. Left false (the default) you get a preview and nothing is written."),
    file: z.string().optional().describe("File containing the commit message"),
    force: z.boolean().optional().default(false).describe("Force commit"),
    keepLocks: z.boolean().optional().default(false).describe("Keep locks after commit"),
    noUnlock: z.boolean().optional().default(false).describe("Do not unlock files"),
    timeout: z.number().int().positive().optional().describe("Per-call timeout in ms.")
  },
  async (args) => {
    try {
      // Step one: show what svn would send, and stop. A commit is visible to the
      // whole team and cannot be edited afterwards, so the preview is the default.
      if (args.confirm !== true) {
        const svc = getSvnService();
        const statuses = await Promise.all(
          args.paths.map(async p => {
            try {
              const st = await svc.getStatus(p, false);
              return { path: p, entries: st.data ?? [], error: undefined as string | undefined };
            } catch (e: any) {
              return { path: p, entries: [], error: e.message as string };
            }
          })
        );

        const lines = statuses.map(s => {
          if (s.error) return `- \`${s.path}\` — ⚠️ ${s.error}`;
          if (s.entries.length === 0) return `- \`${s.path}\` — no local modification`;
          return `- \`${s.path}\`\n` +
            s.entries.map(e => `  - \`${e.status}\` ${e.path}`).join('\n');
        });

        const nothing = statuses.every(s => !s.error && s.entries.length === 0);

        return {
          content: [{
            type: "text",
            text: `🔍 **Commit preview — nothing was written**\n\n` +
              `**Message:** ${args.message}\n` +
              `**Targets:** ${args.paths.length}\n\n` +
              lines.join('\n') + `\n\n` +
              (nothing
                ? `⚠️ None of these paths has a local modification. A commit now would produce ` +
                  `an empty revision or fail. Check the paths first.\n\n`
                : '') +
              `To commit, call again with \`confirm: true\`.`
          }],
        };
      }

      const options = {
        message: args.message,
        file: args.file,
        force: args.force,
        keepLocks: args.keepLocks,
        noUnlock: args.noUnlock,
        timeout: args.timeout
      };

      const result = await getSvnService().commit(options, args.paths);

      if (result.detached) {
        return {
          content: [{ type: "text", text: detachedNotice({
            jobId: result.jobId, target: args.paths[0], what: 'Commit'
          }) + `

⚠️ Verify with \`svn_log\` on the path before considering another commit: a ` +
            `commit repeated because the first looked failed is a DOUBLE commit.` }],
        };
      }

      const commitText = `✅ **Commit Completed**\n\n` +
        `**Message:** ${args.message}\n` +
        `**Files:** ${args.paths.join(', ')}\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\``;

      return {
        content: [{ type: "text", text: commitText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 10. Delete files
server.tool(
  "svn_delete",
  "Remove files from version control",
  {
    paths: z.union([z.string(), z.array(z.string())]).describe("File(s) or director(y|ies) to delete, in the WORKING COPY. A repository URL is refused: deleting straight from the repository is immediate and irreversible."),
    force: z.boolean().optional().default(false).describe("Force deletion"),
    keepLocal: z.boolean().optional().default(false).describe("Keep local copy")
  },
  async (args) => {
    try {
      const options = {
        force: args.force,
        keepLocal: args.keepLocal
      };

      const result = await getSvnService().delete(args.paths, options);
      const pathsArray = Array.isArray(args.paths) ? args.paths : [args.paths];

      const deleteText = `🗑️ **Files Deleted**\n\n` +
        `**Files:** ${pathsArray.join(', ')}\n` +
        `**Keep Local:** ${args.keepLocal ? 'Yes' : 'No'}\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\``;

      return {
        content: [{ type: "text", text: deleteText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 10.5. Status of a detached operation
server.tool(
  "svn_job_status",
  "Check an SVN operation that was DETACHED for outlasting its threshold. Pass the job id from the " +
  "\"still running\" answer, or omit it to list recent jobs. Detached means the answer came back before " +
  "the work finished — not that anything failed. After a job reports done, confirm the effect with " +
  "`svn_info` or `svn_log` on the target rather than repeating the command.",
  {
    jobId: z.string().optional().describe("Job id, e.g. 'svnjob-1'. Omit to list recent jobs.")
  },
  async (args) => {
    try {
      const render = (job: SvnJob) => {
        const elapsed = (job.finishedAt ?? Date.now()) - job.startedAt;
        const icon = job.state === 'running' ? '⏳' : job.state === 'done' ? '✅' : '❌';
        return `${icon} **${job.id}** — ${job.state}
` +
          (job.target ? `- **Target:** \`${job.target}\`
` : '') +
          `- **Elapsed:** ${formatDuration(elapsed)}` +
          (job.state === 'running' ? ' (still going)' : '') + `
` +
          (job.exitCode !== undefined ? `- **Exit code:** ${job.exitCode}
` : '') +
          `- **Command:** ${job.command}
`;
      };

      if (args.jobId) {
        const job = getJob(args.jobId);
        if (!job) {
          return {
            content: [{ type: "text", text:
              `❌ No job \`${args.jobId}\`. Jobs live in memory only, so a server restart forgets them — ` +
              `that is not evidence the operation failed. Verify the effect directly with \`svn_info\` ` +
              `on the target.`
            }],
          };
        }
        const tail = [job.stdoutTail, job.stderrTail].filter(t => t.trim()).join('\n');
        return {
          content: [{ type: "text", text:
            render(job) +
            (tail ? `
**Output (tail):**
\`\`\`
${tail}
\`\`\`
` : '') +
            (job.state === 'running'
              ? `
Still running. Check again later; do not start another operation on this path.`
              : `
Finished. Confirm the effect with \`svn_info\` / \`svn_log\` on the target — the exit ` +
                `code says the command ended, not that the result is what you wanted.`)
          }],
        };
      }

      const jobs = listJobs();
      if (jobs.length === 0) {
        return {
          content: [{ type: "text", text:
            `📭 No detached operations recorded. Only commands that outlast the ` +
            `${Math.round(DETACH_AFTER_MS / 1000)}s threshold get a job — anything that finished inline ` +
            `never appears here.`
          }],
        };
      }
      const running = jobs.filter(j => j.state === 'running');
      return {
        content: [{ type: "text", text:
          `🗂️ **SVN jobs** (${jobs.length})` +
          (running.length ? ` · **${running.length} still running**` : '') + `

` +
          jobs.map(render).join('\n')
        }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 11. Revert changes
server.tool(
  "svn_revert",
  "Revert local changes on files",
  {
    paths: z.union([z.string(), z.array(z.string())]).describe("File(s) or director(y|ies) to revert")
  },
  async (args) => {
    try {
      const result = await getSvnService().revert(args.paths);
      const pathsArray = Array.isArray(args.paths) ? args.paths : [args.paths];

      const revertText = `↩️ **Changes Reverted**\n\n` +
        `**Files:** ${pathsArray.join(', ')}\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\``;

      return {
        content: [{ type: "text", text: revertText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 12. Clean up working copy
server.tool(
  "svn_cleanup",
  "Clean up the working copy from interrupted operations",
  {
    path: z.string().optional().describe("Specific path to clean up")
  },
  async (args) => {
    try {
      const result = await getSvnService().cleanup(args.path);

      const cleanupText = `🧹 **Cleanup Completed**\n\n` +
        `**Path:** ${args.path || 'Current directory'}\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\``;

      return {
        content: [{ type: "text", text: cleanupText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 13. Show the contents of a versioned file (svn cat)
server.tool(
  "svn_cat",
  "Show the contents of a versioned file. Target may be a local path, a repository URL, or a repo-relative path starting with '/' (joined with SVN_URL when configured, so you can just pass '/trunk/path/to/file.sql').",
  {
    target: z.string().describe("Local path, full URL, or repo-relative path like '/trunk/foo.sql'"),
    revision: z.union([
      z.number(),
      z.literal("HEAD"),
      z.literal("BASE"),
      z.literal("COMMITTED"),
      z.literal("PREV"),
      z.string()
    ]).optional().describe("Revision to query (defaults to HEAD/BASE depending on context)")
  },
  async (args) => {
    try {
      const result = await getSvnService().cat(args.target, { revision: args.revision });
      const content = result.data ?? '';

      const revisionLabel = args.revision !== undefined ? String(args.revision) : 'HEAD/BASE';
      const header = `📄 **Contents of ${args.target}** (revision: ${revisionLabel})\n\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n`;

      if (!content) {
        return {
          content: [{ type: "text", text: header + "*(empty file)*" }],
        };
      }

      return {
        content: [{ type: "text", text: header + `\`\`\`\n${content}\n\`\`\`` }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 14. List entries of a versioned directory (svn list)
server.tool(
  "svn_list",
  "List files and directories of a versioned path. Target may be a local path, a repository URL, or a repo-relative path starting with '/' (joined with SVN_URL when configured). Defaults to the working copy when omitted.",
  {
    target: z.string().optional().describe("Local path, full URL, or repo-relative path like '/tags' (defaults to working copy)"),
    revision: z.union([
      z.number(),
      z.literal("HEAD"),
      z.literal("BASE"),
      z.literal("COMMITTED"),
      z.literal("PREV"),
      z.string()
    ]).optional().describe("Revision to query"),
    verbose: z.boolean().optional().default(false).describe("Include revision, author, size and date"),
    recursive: z.boolean().optional().default(false).describe("List recursively"),
    depth: z.enum(["empty", "files", "immediates", "infinity"]).optional().describe("Listing depth"),
    includeExternals: z.boolean().optional().default(false).describe("Include externals")
  },
  async (args) => {
    try {
      const result = await getSvnService().list(args.target, {
        revision: args.revision,
        verbose: args.verbose,
        recursive: args.recursive,
        depth: args.depth,
        includeExternals: args.includeExternals
      });

      const { entries, raw } = result.data!;
      const targetLabel = args.target || 'working copy';

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `📂 **SVN Listing** (${targetLabel})\n\n*(no entries)*\n\n**Execution Time:** ${formatDuration(result.executionTime || 0)}` }],
        };
      }

      const rows = entries.map(e => {
        const icon = e.kind === 'dir' ? '📁' : '📄';
        if (args.verbose) {
          const size = e.size !== undefined ? `${e.size} B` : '-';
          return `${icon} ${e.name}  (r${e.revision ?? '?'}, ${e.author ?? '?'}, ${size}, ${e.date ?? '?'})`;
        }
        return `${icon} ${e.name}`;
      }).join('\n');

      const listText = `📂 **SVN Listing** (${targetLabel}) — ${entries.length} entries\n\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        rows +
        (args.verbose ? `\n\n<details><summary>Raw output</summary>\n\n\`\`\`\n${raw}\n\`\`\`\n</details>` : '');

      return {
        content: [{ type: "text", text: listText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

// 15. Clear SVN credentials cache (to resolve E215004 errors)
server.tool(
  "svn_clear_credentials",
  "Clear the SVN credentials cache to resolve authentication errors",
  {},
  async () => {
    try {
      const result = await getSvnService().clearCredentials();

      const clearText = `🔐 **Credentials Cache Cleared**\n\n` +
        `**Command:** ${result.command}\n` +
        `**Execution Time:** ${formatDuration(result.executionTime || 0)}\n\n` +
        `**Output:**\n\`\`\`\n${result.data}\n\`\`\`\n\n` +
        `**Note:** This can help resolve errors such as:\n` +
        `• E215004: No more credentials or we tried too many times\n` +
        `• Authentication errors due to incorrectly cached credentials`;

      return {
        content: [{ type: "text", text: clearText }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `❌ **Error:** ${error.message}` }],
      };
    }
  }
);

async function runServer() {
  try {
    console.error("Creating SVN MCP Server...");
    console.error("Server info: svn-mcp-server");
    console.error("Version:", VERSION);

    // Validate environment variables
    if (!process.env.SVN_PATH) {
      console.error("Info: SVN_PATH environment variable not set, using 'svn' from PATH");
    } else {
      console.error("SVN_PATH:", process.env.SVN_PATH);
    }

    if (!process.env.SVN_WORKING_DIRECTORY) {
      console.error("Info: SVN_WORKING_DIRECTORY not set, using current directory");
    } else {
      console.error("SVN_WORKING_DIRECTORY:", process.env.SVN_WORKING_DIRECTORY);
    }

    const urlEnv = process.env.SVN_URL || process.env.SVN_REPOSITORY_URL;
    if (urlEnv) {
      console.error("SVN_URL:", urlEnv);
    } else {
      console.error("Info: SVN_URL not set — repo-relative targets (e.g. '/trunk/...') will be treated as local paths");
    }

    if (process.env.SVN_USERNAME) {
      console.error("SVN_USERNAME:", process.env.SVN_USERNAME);
    }

    if (process.env.SVN_PASSWORD) {
      console.error("SVN_PASSWORD:", "***");
    }

    console.error("Starting SVN MCP Server in stdio mode...");

    // Create transport
    const transport = new StdioServerTransport();

    console.error("Connecting server to transport...");

    // Connect server to transport - this should keep the process alive
    await server.connect(transport);

    console.error("MCP Server connected and ready!");
    console.error("Available tools:", [
      "svn_health_check",
      "svn_diagnose",
      "svn_info",
      "svn_status",
      "svn_job_status",
      "svn_log",
      "svn_diff",
      "svn_checkout",
      "svn_update",
      "svn_add",
      "svn_commit",
      "svn_delete",
      "svn_revert",
      "svn_cleanup",
      "svn_cat",
      "svn_list",
      "svn_clear_credentials"
    ]);

  } catch (error) {
    console.error("Error starting server:", error);
    console.error("Stack trace:", (error as Error).stack);
    process.exit(1);
  }
}

// Start the server
runServer();
