/**
 * ethos-example-tool-capabilities
 *
 * A single tool that exercises all five capability categories:
 *
 *   1. network   — scoped fetch restricted to api.github.com
 *   2. secrets   — resolves GITHUB_TOKEN at call time
 *   3. storage   — caches responses in a tool-private KV store
 *   4. fs_reach  — writes a summary file to the personality's fs_reach
 *   5. process   — shells out to `git` to read the local HEAD sha
 *
 * The tool fetches open issues from a GitHub repository, caches the
 * result, optionally writes a summary to disk, and includes the local
 * git HEAD in the output. It compiles against @ethosagent/types but
 * does not run standalone — it needs a wired AgentLoop with capability
 * backends configured.
 */

import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, err, ok } from '@ethosagent/plugin-sdk/tool-helpers';
import type { ToolContext, ToolResult } from '@ethosagent/types';

// -------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------

interface GithubIssuesArgs {
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  writeSummary?: boolean;
}

// -------------------------------------------------------------------------
// Tool
// -------------------------------------------------------------------------

export const githubIssuesTool = defineTool<GithubIssuesArgs>({
  name: 'github_issues',
  description:
    'Fetch issues from a GitHub repository. Optionally write a summary file and include the local git HEAD sha.',
  toolset: 'github',
  maxResultChars: 5_000,

  // -- Capabilities -------------------------------------------------------
  // Each key is opt-in. The framework resolves declared capabilities into
  // scoped implementations on ctx at call time. Undeclared capabilities
  // are absent from ctx (the field is undefined).

  capabilities: {
    // 1. network — only api.github.com is reachable via ctx.scopedFetch.
    network: {
      allowedHosts: ['api.github.com'],
    },

    // 2. secrets — ctx.secretsResolver can resolve GITHUB_TOKEN.
    secrets: ['GITHUB_TOKEN'],

    // 3. storage — ctx.kvStore is a tool-private KV namespace.
    //    Cached entries expire after 300 s by default.
    storage: {
      scope: 'tool-private',
      kind: 'kv',
      ttlSecondsDefault: 300,
    },

    // 4. fs_reach — ctx.scopedFs inherits the personality's read/write paths.
    //    'from-personality' means the tool does not hardcode paths; it uses
    //    whatever the active personality allows.
    fs_reach: {
      read: 'from-personality',
      write: 'from-personality',
    },

    // 5. process — ctx.scopedProcess can spawn only `git`.
    process: {
      allowedBinaries: ['git'],
    },
  },

  // -- Execute ------------------------------------------------------------

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const { owner, repo, state = 'open', writeSummary = false } = args;

    // Validate input.
    if (!owner || !repo) {
      return err('owner and repo are required', 'input_invalid');
    }

    // ---- Capability 2: secrets ------------------------------------------
    if (!ctx.secretsResolver) {
      return err('secrets capability not wired', 'not_available');
    }
    let token: string;
    try {
      token = await ctx.secretsResolver.get('GITHUB_TOKEN');
    } catch {
      return err('GITHUB_TOKEN secret not available', 'not_available');
    }

    // ---- Capability 3: storage (cache check) ----------------------------
    const cacheKey = `${owner}/${repo}:${state}`;
    if (ctx.kvStore) {
      const cached = await ctx.kvStore.get(cacheKey);
      if (cached) {
        return ok(`(cached) ${cached}`);
      }
    }

    // ---- Capability 1: network ------------------------------------------
    if (!ctx.scopedFetch) {
      return err('network capability not wired', 'not_available');
    }

    let issueLines: string[];
    try {
      const url =
        `https://api.github.com/repos/${encodeURIComponent(owner)}` +
        `/${encodeURIComponent(repo)}/issues?state=${state}&per_page=10`;

      const res = await ctx.scopedFetch.fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ethos-example-tool',
        },
        signal: ctx.abortSignal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return err(`GitHub API ${res.status}: ${body.slice(0, 200)}`, 'execution_failed');
      }

      const issues = (await res.json()) as Array<{
        number: number;
        title: string;
        state: string;
        user: { login: string };
        created_at: string;
      }>;

      issueLines = issues.map(
        (i) =>
          `#${i.number} [${i.state}] ${i.title} (by ${i.user.login}, ${i.created_at.slice(0, 10)})`,
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return err('request cancelled', 'execution_failed');
      }
      return err(e instanceof Error ? e.message : String(e), 'execution_failed');
    }

    // ---- Capability 5: process (git HEAD) -------------------------------
    let headSha = 'unknown';
    if (ctx.scopedProcess) {
      try {
        const result = await ctx.scopedProcess.spawn('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: ctx.workingDir,
          timeout: 5_000,
        });
        if (result.exitCode === 0) {
          headSha = result.stdout.trim();
        }
      } catch {
        // Non-fatal — just skip the sha.
      }
    }

    // Build the output value.
    const header = `Issues for ${owner}/${repo} (state: ${state}, local HEAD: ${headSha}):`;
    const body = issueLines.length > 0 ? issueLines.join('\n') : `No ${state} issues found.`;
    const value = `${header}\n${body}`;

    // ---- Capability 3: storage (cache write) ----------------------------
    if (ctx.kvStore) {
      await ctx.kvStore.set(cacheKey, value);
    }

    // ---- Capability 4: fs_reach (optional summary file) -----------------
    if (writeSummary && ctx.scopedFs) {
      const summaryPath = `${ctx.workingDir}/github-issues-summary.txt`;
      try {
        await ctx.scopedFs.write(summaryPath, value);
      } catch {
        // Non-fatal — the personality's fs_reach may not cover workingDir.
      }
    }

    return ok(value);
  },
});

// -------------------------------------------------------------------------
// Plugin lifecycle
// -------------------------------------------------------------------------

export function activate(api: EthosPluginApi): void {
  api.registerTool(githubIssuesTool);
}

export function deactivate(): void {}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
