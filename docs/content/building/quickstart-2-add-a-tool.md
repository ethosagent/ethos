---
title: "Build on Ethos in ten minutes, part 2: add a tool and test it"
description: "Add a tool to the file toolset, wire it in, see it run and test it."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 5-9 of [Build on Ethos in ten minutes](quickstart.md): Export it and wire it in; Add the tool to a personality's allowlist; See the tool execute; Add a test for the tool; Run the full check before you commit.

## Prereqs

- Complete [part 1 of 2](quickstart.md).

## 5. Export it and wire it in

`extensions/tools-file/src/index.ts` exports a `createFileTools()` factory. Find it (it returns an array of tools) and append `sayHiTool` to the returned array:

```typescript
export function createFileTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    patchFileTool,
    searchFilesTool,
    sayHiTool, // <-- add this line
  ];
}
```

`createFileTools()` is called from `packages/wiring/src/index.ts` inside `createAgentLoop`. The registry registration happens there in one line:

```typescript
for (const tool of createFileTools()) tools.register(tool);
```

No additional wiring step. The tool joins the registry on the next `pnpm dev` boot.

## 6. Add the tool to a personality's allowlist

The [ToolRegistry](../getting-started/glossary.md#tool-registry) filters the LLM-visible catalog by the active [personality's](../getting-started/glossary.md#personality) `toolset.yaml`. If a tool is not in that file, the LLM never sees it. The active personality on first install is `engineer` — check its bundled toolset:

```bash
cat extensions/personalities/data/engineer/toolset.yaml
```

`read_file`, `write_file`, and friends are listed. To get `say_hi` in front of the model, either edit this file (risks committing test edits) or override the personality from `~/.ethos/personalities/engineer/toolset.yaml` — user files win over bundled ones on the same id.

The fast path is the second:

```bash
mkdir -p ~/.ethos/personalities/engineer
cp extensions/personalities/data/engineer/toolset.yaml ~/.ethos/personalities/engineer/
echo "- say_hi" >> ~/.ethos/personalities/engineer/toolset.yaml
```

The registry hot-reloads on file mtime — the change picks up on the next [turn](../getting-started/glossary.md#turn) without restarting `pnpm dev`.

## 7. See the tool execute

Restart `pnpm dev` (so the new export lands in the running process) and send:

```
You > use the say_hi tool to greet ada lovelace.
```

The chat surface streams the events as they happen:

```
[tool_start  ] say_hi { name: "Ada Lovelace" }
[tool_end    ] say_hi · ok · 1ms
Hi, Ada Lovelace! Glad to meet you.
```

The `[tool_start]` and `[tool_end]` lines come from the `AgentLoop`'s `AsyncGenerator<AgentEvent>` stream. The final text is the model's response after it saw the tool result. Total round-trip: two LLM calls (one to pick the tool, one to write the reply) plus your 1ms `execute`.

If the agent refuses or picks a different tool, the most common cause is that `say_hi` is missing from the active personality's `toolset.yaml`. Verify:

```
You > list the tools you can call.
```

If `say_hi` is not in the list, the toolset file is the problem. If it is in the list but the agent does not call it, the `description` is not compelling enough — sharpen the prose so the model picks it.

## 8. Add a test for the tool

Tools are pure functions in this codebase — easy to test. Create `extensions/tools-file/src/__tests__/say-hi.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@ethosagent/types';
import { sayHiTool } from '..';

const ctx: ToolContext = {
  sessionId: 't',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: process.cwd(),
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

describe('sayHiTool', () => {
  it('greets the named person', async () => {
    const result = await sayHiTool.execute({ name: 'Ada' }, ctx);
    expect(result).toEqual({ ok: true, value: 'Hi, Ada! Glad to meet you.' });
  });

  it('rejects missing name', async () => {
    const result = await sayHiTool.execute({ name: '' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
  });
});
```

Run it:

```bash
pnpm --filter @ethosagent/tools-file test
```

Both assertions pass. The framework never gets involved in this test — you exercise the `execute` function directly with a stub `ToolContext`. That is the model for every tool test in the repo: read `extensions/tools-file/src/__tests__/` for the production examples.

## 9. Run the full check before you commit

Before pushing, run the same command CI runs:

```bash
pnpm check
```

That covers typecheck, lint, and tests. If `pnpm lint` reports fixable issues, `pnpm lint:fix` rewrites them in place; re-run `pnpm check` to confirm clean.

The same script is wrapped by `make check`. Use whichever you prefer; CI invokes the scripts directly via `scripts/run-checks.sh`.

## What you learned

- The repo is a pnpm workspace; `make prepare` installs dependencies and sets up git hooks.
- `pnpm dev` runs `tsx apps/ethos/src/index.ts` — no build step, edits are live on next process start.
- `pnpm check` runs typecheck + lint + tests; the same script is what CI runs.
- A tool is an object implementing `Tool<TArgs>` from `@ethosagent/types`: `name`, `description`, `schema`, `execute`, optional `maxResultChars` and `isAvailable`.
- The `ToolRegistry` filters the LLM-visible toolset by the active personality's `toolset.yaml`; user files at `~/.ethos/personalities/<id>/` override the bundled defaults.
- Tools are unit-testable in isolation — pass a stub `ToolContext` and assert on the returned `ToolResult`.

## Next step

You wrote a tool that lives inside the monorepo. Next, learn the full tool contract — `ToolResult` codes, `maxResultChars` budgeting, `isAvailable` gating, the audience boundary on progress events — then ship a real tool through the same loop.

- [Write your first tool](./tutorials/write-your-first-tool.md) — the long-form version of step 4-7 with the production contract.
- [Add an LLM provider](./tutorials/add-an-llm-provider.md) — drop in a custom model by implementing `LLMProvider`.
- [Add a channel adapter](./tutorials/add-a-channel-adapter.md) — bridge a new messaging platform without re-implementing dedup.
- [Tool interface reference](./reference/tool-interface.md) — every field on `Tool<TArgs>` and `ToolContext`.
