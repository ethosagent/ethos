---
title: "Write your first tool with capabilities"
description: "Build a tool that declares network and storage capabilities — the framework provides scoped fetch, KV storage, and secrets at call time."
kind: tutorial
audience: developer
slug: first-custom-tool-with-capabilities
time: "15 min"
updated: 2026-05-14
---

Build a `github_issues` tool that fetches open issues from the GitHub API. Unlike the plain tool in [Write your first tool](./write-your-first-tool.md), this one declares **capabilities** -- network access, secret resolution, and KV storage -- and receives scoped implementations at call time instead of reaching for globals.

## Goal

- A `github_issues` tool declaring `network`, `secrets`, and `storage` capabilities.
- `execute` that uses `ctx.scopedFetch`, `ctx.secretsResolver`, and `ctx.kvStore`.
- Understanding of what happens when a capability is undeclared (the field is absent from `ctx`).
- Registration-time validation against personality policy.

## Prereqs

Everything from [Write your first tool](./write-your-first-tool.md), plus familiarity with `ToolCapabilities` in `packages/types/src/tool-capabilities.ts` and a GitHub personal access token for testing.

## 1. Read the capability contract

Open `packages/types/src/tool-capabilities.ts`. Five opt-in categories:

```typescript
export interface ToolCapabilities {
  network?: { allowedHosts: string[] };
  secrets?: SecretRef[];
  storage?: { scope: StorageScope; kind: 'kv'; ttlSecondsDefault?: number };
  fs_reach?: { read?: string[] | 'from-personality'; write?: string[] | 'from-personality' };
  process?: { allowedBinaries: string[] };
}
```

Declaring a capability does two things: (1) at registration time the framework validates it against personality policy, and (2) at call time `executeParallel` resolves it into a scoped implementation on `ctx`. A tool that does not declare a capability does not receive the corresponding `ctx` field.

## 2. Create the plugin package

Follow the same package setup as [Write your first tool, section 3](./write-your-first-tool.md#3-create-the-plugin-package), naming the package `ethos-plugin-github`.

## 3. Write the tool with capabilities

Create `src/index.ts`:

```typescript
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, err, ok } from '@ethosagent/plugin-sdk/tool-helpers';
import type { ToolContext, ToolResult } from '@ethosagent/types';

interface GithubIssuesArgs {
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
}

const githubIssuesTool = defineTool<GithubIssuesArgs>({
  name: 'github_issues',
  description: 'List issues for a GitHub repository.',
  toolset: 'github',
  maxResultChars: 5_000,

  capabilities: {
    network: { allowedHosts: ['api.github.com'] },
    secrets: ['GITHUB_TOKEN'],
    storage: { scope: 'tool-private', kind: 'kv', ttlSecondsDefault: 300 },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const { owner, repo, state = 'open' } = args;
    if (!owner || !repo) return err('owner and repo are required', 'input_invalid');

    // Capability: secrets -- resolve the token at call time.
    if (!ctx.secretsResolver) return err('secrets not available', 'not_available');
    const token = await ctx.secretsResolver.get('GITHUB_TOKEN');

    // Capability: storage -- check the cache first.
    const cacheKey = `${owner}/${repo}:${state}`;
    if (ctx.kvStore) {
      const cached = await ctx.kvStore.get(cacheKey);
      if (cached) return ok(cached);
    }

    // Capability: network -- scoped fetch restricted to api.github.com.
    if (!ctx.scopedFetch) return err('network not available', 'not_available');

    try {
      const url =
        `https://api.github.com/repos/${encodeURIComponent(owner)}` +
        `/${encodeURIComponent(repo)}/issues?state=${state}&per_page=10`;
      const res = await ctx.scopedFetch.fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
        signal: ctx.abortSignal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return err(`GitHub API ${res.status}: ${body.slice(0, 200)}`, 'execution_failed');
      }

      const issues = (await res.json()) as Array<{
        number: number; title: string; state: string; user: { login: string };
      }>;
      const lines = issues.map((i) => `#${i.number} [${i.state}] ${i.title} (by ${i.user.login})`);
      const value = lines.length > 0
        ? `Issues for ${owner}/${repo}:\n${lines.join('\n')}`
        : `No ${state} issues found for ${owner}/${repo}.`;

      if (ctx.kvStore) await ctx.kvStore.set(cacheKey, value);
      return ok(value);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return err('cancelled', 'execution_failed');
      return err(e instanceof Error ? e.message : String(e), 'execution_failed');
    }
  },
});

export function activate(api: EthosPluginApi): void { api.registerTool(githubIssuesTool); }
export function deactivate(): void {}
const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

Key points:

- **`ctx.scopedFetch`** replaces raw `fetch`. The host allowlist is the intersection of your declared `allowedHosts` and the personality's network policy. Requests outside that set are rejected before leaving the process.
- **`ctx.secretsResolver`** resolves named refs. The resolver is scoped -- it refuses refs the tool did not declare.
- **`ctx.kvStore`** is namespaced by `tool-private`. Other tools cannot read it. `ttlSecondsDefault` sets the default expiry; individual `set` calls can override.

## 4. What happens when a capability is undeclared

Remove the `network` line from `capabilities` and `ctx.scopedFetch` becomes `undefined`. Your guard (`if (!ctx.scopedFetch)`) returns a clean `not_available` error. The same applies to every capability: undeclared means absent from `ctx`. Always guard; return `err(...)` when missing.

## 5. Registration-time validation

`validateRegistration(tool, personality)` runs at startup for each tool. It checks:

- **network**: every host in `allowedHosts` must be covered by a pattern in `personality.safety.network.allow`.
- **fs_reach**: explicit paths must fall under the personality's `fs_reach` directories.

To fix a validation error, add the host to the personality config:

```yaml
safety:
  network:
    allow:
      - "api.github.com"
```

## 6. Wire and run

Install, attach, and add `github_issues` to the toolset -- same steps as [Write your first tool, sections 5-6](./write-your-first-tool.md#5-install-the-plugin). Then:

```bash
ethos chat
```

```
You > show me open issues on ethosagent/ethos

[tool_start  ] github_issues { owner: "ethosagent", repo: "ethos", state: "open" }
[tool_end    ] github_issues · ok · 623ms

Here are the open issues for ethosagent/ethos:
#42 [open] Memory sync drops entries on concurrent writes (by alice)
...
```

A second request within 5 minutes hits the KV cache -- no API call.

## What you learned

- `capabilities` is a static declaration on the tool telling the framework what it needs.
- The framework resolves declarations into scoped implementations on `ctx`: `scopedFetch`, `secretsResolver`, `kvStore`, `scopedFs`, `scopedProcess`.
- Undeclared capabilities are absent from `ctx`. Guard and degrade gracefully.
- Registration-time validation checks hosts and paths against personality policy.
- `storage.scope` controls isolation: `tool-private`, `session`, or `personality`.

## Next step

- [Tool interface reference](../reference/tool-interface.md) -- full field reference including capabilities.
- [Write your first tool](./write-your-first-tool.md) -- the plain tool tutorial, without capabilities.
- `examples/example-tool/` -- a single-file example exercising all five capability categories.
