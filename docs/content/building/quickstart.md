---
title: "Build on Ethos in ten minutes"
description: "Clone the monorepo, install with pnpm, run pnpm check, write a 20-line tool, and see the agent call it in chat — start to finish in ten minutes."
kind: tutorial
audience: developer
slug: quickstart
time: "10 min"
updated: 2026-11-03
---

This page is for contributors and plugin authors. The shortest path from a fresh clone to a custom [tool](../getting-started/glossary.md#tool) the agent calls in chat. End-user setup lives in the [Using Ethos quickstart](../using/quickstart.md); skip that — you build against source here, not against the published CLI.

## Goal

By the end, you have:

- The `ethos` monorepo cloned with all workspace packages installed via pnpm.
- `pnpm check` (typecheck + lint + test) passing on the main branch.
- `pnpm dev` running an interactive chat off your local tree — no build step.
- A 20-line `say_hi` tool in `extensions/tools-file/src/` that the agent calls when you ask it to.
- A working dev loop: edit `.ts`, send a chat message, see the change in the next [turn](../getting-started/glossary.md#turn).

The point is the dev loop, not the tool. By minute ten, you can sketch any tool you like with the same shape.

## Prereqs

- Node 24 or newer. Check with `node --version`. The repo pins via `.nvmrc`; `make setup` installs it if you use nvm.
- pnpm 10. `corepack enable` works, or `npm install -g pnpm@10`. The repo pins `packageManager` in the root `package.json`.
- Git, plus a checkout of `https://github.com/ethosagent/ethos`.
- An Anthropic API key in the shell (`export ANTHROPIC_API_KEY=sk-ant-...`). OpenAI / OpenRouter / Ollama work via the OpenAI-compat provider, but Anthropic is the path of least resistance — Claude is the default model.
- A terminal you can run two panes in (one for `pnpm dev`, one for `pnpm test`).

## Parts

| Part | Covers |
|---|---|
| 1. Build on Ethos in ten minutes (this page) | Steps 1-4: Clone and install, Run the full check before you change anything, Start a chat against your local tree, Add a tool to the file toolset |
| [2. Add a tool and test it](quickstart-2-add-a-tool.md) | Steps 5-9: Export it and wire it in, Add the tool to a personality's allowlist, See the tool execute, Add a test for the tool, Run the full check before you commit |

## 1. Clone and install

```bash
git clone https://github.com/ethosagent/ethos.git
cd ethos
make prepare
```

`make prepare` runs `pnpm install --frozen-lockfile` and installs the git hooks via lefthook. It is idempotent — re-run it any time you switch branches.

If the install fails, the most common cause is a Node version mismatch (`pnpm` ignored the `.nvmrc`). Run `nvm use` first, then `make prepare` again.

When it finishes, you should see five workspace packages and dozens of extensions resolved:

```bash
pnpm list --depth -1 | head -20
```

The interesting roots: `packages/types` (zero-dep interfaces), `packages/core` (`AgentLoop`, `ToolRegistry`, `HookRegistry`), `apps/ethos` (CLI entry), and the `extensions/*` tree.

## 2. Run the full check before you change anything

```bash
pnpm check
```

That runs `pnpm typecheck && pnpm lint && pnpm test` — exactly what CI runs on every pull request. Vitest will exercise ~3000 tests across the workspace; expect 30-60 seconds on a recent laptop.

A clean `pnpm check` on `main` is the baseline. Any failure here is a repo-side issue, not your code — open an issue with the failing line.

You can also run pieces in isolation:

```bash
pnpm typecheck                                      # tsc --noEmit
pnpm lint                                           # biome check .
pnpm test                                           # vitest run
pnpm --filter @ethosagent/core test                 # one package only
pnpm --filter @ethosagent/core test --watch         # watch mode for one package
```

The watch-mode workflow is the one you actually want once you start editing. Vitest is fast enough that "save the file, see the assertion fail or pass" is the right inner loop.

## 3. Start a chat against your local tree

```bash
pnpm dev
```

`dev` is `tsx apps/ethos/src/index.ts` — Node 24 executes the TypeScript source directly through tsx. No `dist/`, no build step, no watch process. Every `import` resolves against `./src/*` via the workspace `exports` and root `tsconfig` path aliases, so any edit you make is live on the next process start.

First run prompts for an LLM provider and key. Pick `anthropic`, paste the key, accept the defaults — `~/.ethos/config.yaml` is written automatically.

Once the chat opens, send a probe:

```
You > list the tools you can call. one per line, with one phrase per tool.
```

The reply enumerates the built-in toolset: `read_file`, `write_file`, `web_search`, `bash`, `memory_read`, `memory_write`, and friends. These are the tools you are about to join.

Press `Ctrl+C` to exit, or leave the chat running in a second pane — you will come back to it after you write the tool.

## 4. Add a tool to the file toolset

The fastest place to add a tool is alongside an existing extension. Open `extensions/tools-file/src/index.ts` — it already imports `Tool`, `ToolResult`, and `ToolContext` from `@ethosagent/types`. Add this at the bottom of the file:

```typescript
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

export const sayHiTool: Tool<{ name: string }> = {
  name: 'say_hi',
  description: 'Greet a person by name. Use when the user wants a friendly greeting.',
  toolset: 'file',
  maxResultChars: 200,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The person to greet' },
    },
    required: ['name'],
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const { name } = args;
    if (!name || typeof name !== 'string') {
      return { ok: false, error: 'name is required', code: 'input_invalid' };
    }
    return { ok: true, value: `Hi, ${name}! Glad to meet you.` };
  },
};
```

Three things to notice:

- **`schema` is JSON Schema, not Zod.** That shape is what the LLM sees — every property and `required` entry is documentation for the model.
- **`execute` returns `ToolResult`.** Either `{ ok: true, value: string }` or `{ ok: false, error, code }`. The `value` string is appended verbatim to the LLM's next turn input.
- **`maxResultChars` caps the per-call output.** The framework's default per-turn budget is 80,000 chars split across concurrent calls; a tool can declare a tighter cap when its outputs are small by definition. See the [Tool interface reference](./reference/tool-interface.md) for the full contract.

## What you learned

- Steps 1-4 done: Clone and install; Run the full check before you change anything; Start a chat against your local tree; Add a tool to the file toolset.

## Next step

Continue with [part 2 of 2: add a tool and test it](quickstart-2-add-a-tool.md).
