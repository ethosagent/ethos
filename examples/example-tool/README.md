# Example tool with capabilities

A single-file Ethos plugin demonstrating all five capability categories on one tool (`github_issues`):

| Capability | Declaration | Runtime field on `ctx` | What it does here |
|---|---|---|---|
| **network** | `allowedHosts: ['api.github.com']` | `ctx.scopedFetch` | Fetches issues from the GitHub API. Only `api.github.com` is reachable. |
| **secrets** | `['GITHUB_TOKEN']` | `ctx.secretsResolver` | Resolves the GitHub token at call time without reading `process.env`. |
| **storage** | `scope: 'tool-private', kind: 'kv'` | `ctx.kvStore` | Caches API responses for 5 minutes in a tool-private KV namespace. |
| **fs_reach** | `read/write: 'from-personality'` | `ctx.scopedFs` | Optionally writes a summary file, respecting the personality's path allowlist. |
| **process** | `allowedBinaries: ['git']` | `ctx.scopedProcess` | Runs `git rev-parse --short HEAD` to include the local commit in the output. |

## Structure

```
examples/example-tool/
  package.json        workspace package
  src/index.ts        tool + plugin lifecycle (single file)
  README.md           this file
```

## Usage

This example compiles but does not run standalone -- it requires a wired `AgentLoop` with capability backends. To try it:

1. Add the directory to `~/.ethos/config.yaml` under `plugins:`.
2. Add `github_issues` to your personality's `toolset.yaml`.
3. Ensure the personality's `safety.network.allow` includes `api.github.com`.
4. Set a `GITHUB_TOKEN` secret in your secrets backend (or env).
5. Run `ethos chat` and ask about issues on any public repo.

## What to look for in the code

- The `capabilities` block is a static declaration -- it tells the framework what the tool needs.
- `execute` uses `ctx.scopedFetch`, `ctx.secretsResolver`, `ctx.kvStore`, `ctx.scopedFs`, and `ctx.scopedProcess` instead of raw globals.
- Each capability field is guarded with a null check. If a capability is undeclared (or the backend is not wired), the field is `undefined` and the tool degrades gracefully.
- The `defineTool` helper from `@ethosagent/plugin-sdk` defaults `capabilities` to `{}` when omitted, so existing tools that do not declare capabilities continue to work unchanged.

See the [tutorial](../../docs/content/building/tutorials/first-custom-tool-with-capabilities.md) for a step-by-step walkthrough.
