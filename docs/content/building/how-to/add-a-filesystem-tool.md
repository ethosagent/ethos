---
title: "Add a filesystem tool"
description: "Declare fs_reach capabilities, use ctx.scopedFs to read and write files within the personality's reach boundary."
kind: how-to
audience: developer
slug: add-a-filesystem-tool
updated: 2026-05-14
---

## Task

Build a [tool](../../getting-started/glossary.md#tool) that reads or writes files on disk, using the capability framework to declare its filesystem reach. The framework resolves the declaration into a scoped accessor that enforces path boundaries at runtime.

## Result

A tool whose filesystem access is declared in `capabilities.fs_reach` and routed through `ctx.scopedFs`. The [personality](../../getting-started/glossary.md#personality) controls the final reach via intersection. Attempts to read or write outside the allowed paths throw `PATH_NOT_REACHABLE`.

## Prereqs

- `@ethosagent/types` (for `Tool`, `ToolResult`, `ToolCapabilities`).
- A personality with `fs_reach` configured (or a test harness that provides `CapabilityBackends.storage` and `personalityFsReach`).

## Steps

### 1. Choose between explicit paths and from-personality

The `fs_reach` capability has two modes for each direction (read, write).

**Explicit paths** -- the tool declares the exact directories it needs:

```ts
capabilities: {
  fs_reach: {
    read: ['/data/reports'],
    write: ['/data/output'],
  },
},
```

Use this when the tool has a fixed, known scope. The capability validator (`validateRegistration`) checks that every declared path falls within the personality's `fs_reach`; paths outside are flagged as validation errors.

**`'from-personality'`** -- the tool inherits whatever the active personality allows:

```ts
capabilities: {
  fs_reach: {
    read: 'from-personality',
    write: 'from-personality',
  },
},
```

Use this for general-purpose tools (like `read_file` or `write_file`) where the personality defines the boundary. The resolver substitutes the personality's `fs_reach.read` and `fs_reach.write` arrays at runtime.

### 2. Declare the capability

A tool that reads a configuration file and writes a summary:

```ts title="src/summarize-config.ts"
import type { Tool, ToolResult } from '@ethosagent/types';

export const summarizeConfigTool: Tool = {
  name: 'summarize_config',
  description: 'Read a config file and write a plain-text summary alongside it.',
  toolset: 'file',
  capabilities: {
    fs_reach: {
      read: 'from-personality',
      write: 'from-personality',
    },
  },
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the config file' },
    },
    required: ['path'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    // ... (see step 3)
  },
};
```

### 3. Use ctx.scopedFs for all file operations

`ctx.scopedFs` exposes four methods: `read`, `write`, `exists`, and `list`. Every call runs a path-boundary check before delegating to the underlying `Storage` implementation.

```ts
async execute(args, ctx): Promise<ToolResult> {
  const { path } = args as { path: string };
  if (!path) return { ok: false, error: 'path is required', code: 'input_invalid' };

  const fs = ctx.scopedFs;
  if (!fs) {
    return { ok: false, error: 'Filesystem capability not configured', code: 'not_available' };
  }

  try {
    const content = await fs.read(path);
    const summary = `Lines: ${content.split('\n').length}\nSize: ${content.length} chars`;
    const summaryPath = path.replace(/(\.[^.]+)$/, '.summary.txt');
    await fs.write(summaryPath, summary);
    return { ok: true, value: `Summary written to ${summaryPath}` };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('PATH_NOT_REACHABLE')) {
      return { ok: false, error: err.message, code: 'execution_failed' };
    }
    throw err;
  }
},
```

Do not import from `node:fs` or `node:fs/promises` in tool code. The scoped accessor is the enforcement boundary; raw filesystem calls bypass it.

### 4. Handle PATH_NOT_REACHABLE errors

`ScopedFsImpl.checkReach()` throws an `Error` with message `PATH_NOT_REACHABLE: <kind> not permitted for <path>` when a path falls outside the allowed set. Catch it and return a tool-friendly error so the LLM gets an actionable message:

```ts
try {
  const content = await fs.read(path);
  // ...
} catch (err) {
  if (err instanceof Error && err.message.startsWith('PATH_NOT_REACHABLE')) {
    return { ok: false, error: err.message, code: 'execution_failed' };
  }
  throw err;
}
```

The built-in `read_file` and `write_file` tools use the same pattern. When `ctx.storage` is a `ScopedStorage` (wired by AgentLoop), it throws `BoundaryError` instead; the file tools translate that into a structured tool failure via `boundaryFailure()`.

### 5. Understand personality intersection

The resolver computes the final reach by combining the tool's declaration with the personality's `fs_reach`:

| Tool declares | Personality fs_reach.read | Resolved read paths |
|---|---|---|
| `['/data']` | `['/data', '/home']` | `{'/data'}` |
| `['/data']` | `['/home']` | validation error (path not covered) |
| `'from-personality'` | `['/data', '/home']` | `{'/data', '/home'}` |
| `'from-personality'` | undefined | `{}` (empty -- tool reads nothing) |
| `['/data']` | undefined (no personality fs_reach) | validation error at registration |

Explicit paths are checked at registration time by `validateRegistration()` in `packages/core/src/capability-validator.ts`. A tool that declares a path the personality does not cover produces a `CapabilityValidationError`. The `'from-personality'` sentinel defers the check to runtime resolution.

The path check uses prefix matching: a path is reachable if it equals an allowed prefix or starts with `<prefix>/`. A tool declaring read access to `/data/reports` is covered by a personality allowing `/data`.

## Verify

Write a test that confirms boundary enforcement:

```ts
import { ScopedFsImpl } from '@ethosagent/core/scoped';

const storage = { read: vi.fn(), write: vi.fn(), exists: vi.fn(), list: vi.fn(), /* ... */ };
const scopedFs = new ScopedFsImpl(storage, new Set(['/allowed']), new Set(['/allowed']));

await expect(scopedFs.read('/allowed/file.txt')).resolves.not.toThrow();
await expect(scopedFs.read('/forbidden/file.txt')).rejects.toThrow('PATH_NOT_REACHABLE');
```

Run `pnpm check` to confirm the tool passes typecheck, lint, and tests.

## Troubleshoot

**`PATH_NOT_REACHABLE: read not permitted for /some/path`.** -- The resolved read set does not include the requested path. If using `'from-personality'`, check the personality's `fs_reach.read` array. If using explicit paths, confirm they are a subset of the personality's reach.

**`ctx.scopedFs` is undefined.** -- The tool declared `fs_reach` but no `CapabilityBackends.storage` was provided to the registry. In production this means the wiring layer did not pass a `Storage` instance. In tests, provide a mock storage in the backends.

**Validation error at registration: path not covered.** -- The tool declares an explicit path that the personality's `fs_reach` does not contain. Either widen the personality's reach or switch to `'from-personality'` if the tool should inherit the personality's boundary.

**Symlinks escape the boundary.** -- `ScopedFsImpl` normalizes paths with `resolve()` before checking. Symlinks that point outside the allowed tree are caught by the canonical path comparison. The built-in file tools also canonicalize before boundary checks.
