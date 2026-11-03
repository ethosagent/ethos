---
title: "Tool interface: ToolContext and ToolFilterOpts"
description: "ToolContext and ToolFilterOpts interfaces."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

What a tool receives when it runs, and how tool lists are filtered. Part of the [Tool interface reference](../tool-interface.md).

## ToolContext {#tool-context}

### Signature {#tool-context-signature}

```ts
import type { ToolContext, ToolProgressEvent } from '@ethosagent/types';

export interface ToolContext {
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
  agentId?: string;
  rootSessionKey?: string;
  jobId?: string;
  origin?: string;
  a2aDelegation?: { traceId: string; depth: number; reserveOutbound: () => boolean };
  scriptTools?: import('@ethosagent/types').ScriptToolsApi;
  toolCallId?: string;
  personalityId?: string;
  memoryScopeId?: string;
  userScopeId?: string;
  teamId?: string;
  currentTurn: number;
  messageCount: number;
  abortSignal: AbortSignal;
  emit: (event: ToolProgressEvent) => void;
  resultBudgetChars: number;
  storage?: import('@ethosagent/types').Storage;
  readMtimes?: Map<string, { mtimeMs: number; readAtTurn: number }>;
  networkPolicy?: {
    allow?: string[];
    deny?: string[];
    allow_private_urls?: boolean;
  };
  kvStore?: import('@ethosagent/types').KeyValueStore;
  secretsResolver?: import('@ethosagent/types').ScopedSecretsResolver;
  scopedFetch?: import('@ethosagent/types').ScopedFetch;
  scopedFs?: import('@ethosagent/types').ScopedFs;
  scopedProcess?: import('@ethosagent/types').ScopedProcess;
  attachments?: import('@ethosagent/types').ScopedAttachments;
  dryRun?: boolean;
  getContext?: <T>(key: string) => T | undefined;
  setContext?: <T>(key: string, value: T) => void;
  llm?: import('@ethosagent/types').SimpleCompletion;
}
```

Field order and types match [`packages/types/src/tool.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool.ts). Doc comments are omitted, and the source's relative `import('./storage')`-style paths are written as the `@ethosagent/types` re-exports.

### Members {#tool-context-members}

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Stable id of the current [session](../../../getting-started/glossary.md#session). |
| `sessionKey` | `string` | Human-meaningful session key (e.g. `cli:my-repo`). |
| `platform` | `string` | Surface the turn is running on (`cli`, `telegram`, `discord`, ...). |
| `workingDir` | `string` | Process cwd at turn start. Anchor relative paths against this. |
| `agentId` | `string \| undefined` | Stable agent identity (multi-agent / [mesh](../../../getting-started/glossary.md#mesh) deployments). |
| `rootSessionKey` | `string \| undefined` | Root session key for background-job scoping. Set by the background executor on a detached child so nested spawns inherit the same root. Absent on ordinary turns; background tools fall back to `sessionKey`. |
| `jobId` | `string \| undefined` | The background job id, stamped by `BackgroundExecutor.runOne`. Always `undefined` on a foreground turn — there is no fallback. `clarify` keys its question lane on `jobId ?? sessionId`. |
| `origin` | `string \| undefined` | Where the turn came from, as `platform:chatId`, on channel turns. Unset otherwise. `goal_create` stamps it onto `Goal.origin`. |
| `a2aDelegation` | object \| undefined | Set by the A2A runner when the turn services an inbound A2A task. The outbound A2A tool signs an onward call at `depth + 1` and calls `reserveOutbound()` against the per-trace fan-out budget. Absent on normal turns. |
| `scriptTools` | `ScriptToolsApi \| undefined` | Set per turn when a `ScriptToolBridge` is wired. `run_code` threads it so an in-script `ethos.call(name, args)` goes through the same enforcement as a model-issued call. Holds live callbacks, so it never travels in the serializable `ToolExecuteRequest`. |
| `toolCallId` | `string \| undefined` | This call's own id, copied from `ToolExecuteRequest.toolCallId`. `run_code` passes it as `parentToolCallId` to namespace inner calls. Hand-built contexts may omit it; tools must tolerate absence. |
| `personalityId` | `string \| undefined` | Active [personality](../../../getting-started/glossary.md#personality). Thread through to memory and storage. |
| `memoryScopeId` | `string \| undefined` | The turn's [memory scope](../../../getting-started/glossary.md#memory-scope), always `personality:<personalityId>` (`memScopeId` in `packages/core/src/agent-loop/stages/turn-setup.ts`). Memory tools pass it to the provider unchanged. AgentLoop sets it on every call, and the realtime voice host sets the same scope for a call with a personality (`createRealtimeToolHost` in `extensions/tools-voice/src/realtime-host.ts`). A context built outside any personality's conversation — the web tool-test probe, a plugin panel call — has none, and `memory_read` / `memory_write` / `meet_join` then return `not_available` rather than invent a scope (`NO_MEMORY_SCOPE` in `extensions/tools-memory/src/index.ts`). |
| `userScopeId` | `string \| undefined` | `user:<userId>` when the turn carries a user id — a gateway turn whose sender the identity map resolved. Memory tools use it for `store: 'user'`. Absent under `ethos chat`, where `store: 'user'` reads the personality's own `USER.md`. |
| `teamId` | `string \| undefined` | Active team id. Set by AgentLoop when the loop runs inside a team (`WiringConfig.teamName`). Team memory tools use this to build the `team:<id>` scope id. Absent when running solo. |
| `currentTurn` | `number` | 1-indexed [turn](../../../getting-started/glossary.md#turn) counter for the session. |
| `messageCount` | `number` | Total messages in the session so far. |
| `abortSignal` | `AbortSignal` | Fires when the user cancels or the turn times out. Wire into `fetch`, child processes, anywhere blocking. |
| `emit` | `(ev: ToolProgressEvent) => void` | Emits a [`tool_progress`](../agent-event.md#tool-progress) event. See [ToolProgressEvent](tool-and-result.md#tool-progress-event). |
| `resultBudgetChars` | `number` | Maximum characters the success `value` may contain before truncation. See [tool-result-budget](../../explanation/tool-result-budget.md). |
| `storage` | `Storage \| undefined` | Per-turn [Storage](../storage-interface.md) decorated with the personality's `fs_reach` allowlist. Tools that touch `~/.ethos/` must use this rather than `node:fs`. |
| `readMtimes` | `Map<string, { mtimeMs: number; readAtTurn: number }> \| undefined` | Per-run mtime registry for stale-write prevention. Populated by `read_file`; checked by `write_file` / `patch_file` before writing. Absent in tests that do not wire AgentLoop. |
| `networkPolicy` | object \| undefined | Per-personality network reach. URL-capable tools must thread this through `safeFetch` from `@ethosagent/safety-network`. |
| `kvStore` | `KeyValueStore \| undefined` | Key-value storage capability. See [tool-capabilities](../tool-capabilities.md). |
| `secretsResolver` | `ScopedSecretsResolver \| undefined` | Secrets resolution capability. See [tool-capabilities](../tool-capabilities.md). |
| `scopedFetch` | `ScopedFetch \| undefined` | Scoped HTTP fetch capability. See [tool-capabilities](../tool-capabilities.md). |
| `scopedFs` | `ScopedFs \| undefined` | Scoped filesystem capability. See [tool-capabilities](../tool-capabilities.md). |
| `scopedProcess` | `ScopedProcess \| undefined` | Scoped process execution capability. See [tool-capabilities](../tool-capabilities.md). |
| `attachments` | `ScopedAttachments \| undefined` | Attachment handling capability. See [tool-capabilities](../tool-capabilities.md). |
| `dryRun` | `boolean \| undefined` | When true, the tool should return synthetic results without performing side effects. |
| `getContext` | `(<T>(key: string) => T \| undefined) \| undefined` | Reads a value from the run's shared context store (`ContextStore`, `packages/core/src/context-store.ts`). Absent where the context belongs to no run, such as the web tool-test probe. |
| `setContext` | `(<T>(key: string, value: T) => void) \| undefined` | Writes a value into the same store, visible to later tool calls in the run. Absent under the same conditions as `getContext`. |
| `llm` | `SimpleCompletion \| undefined` | A one-shot completion client (`packages/types/src/plugin-llm.ts`). AgentLoop sets it on the turn's effective model (`SimpleCompletionImpl` in `packages/core/src/agent-loop/stages/tool-processing.ts`). Absent on contexts built outside a turn; a tool must tolerate that. |

### Notes {#tool-context-notes}

- `emit` defaults events to `audience: 'internal'` if the tool omits the field. Opt into `'user'` only when silent latency would confuse the user.
- `storage` is undefined in some test wirings -- tools that need filesystem access should fall back gracefully (e.g. read-only) rather than crash.
- The same `abortSignal` is passed to the LLM call. Once aborted, expect `abortSignal.aborted === true` for the rest of the turn.
- `readMtimes` enables the `STALE_WRITE` error code. Tools skip the mtime check when the map is undefined.

## ToolFilterOpts {#tool-filter-opts}

### Signature {#tool-filter-opts-signature}

```ts
import type { ToolFilterOpts } from '@ethosagent/types';

export interface ToolFilterOpts {
  allowedMcpServers?: string[];
  allowedPlugins?: string[];
}
```

### Members {#tool-filter-opts-members}

| Field | Type | Description |
|---|---|---|
| `allowedMcpServers` | `string[] \| undefined` | MCP server allowlist. Tools named `mcp__<server>__*` are excluded unless their server name is in this list. `undefined` means no MCP filter. |
| `allowedPlugins` | `string[] \| undefined` | Plugin allowlist. Tools registered by a plugin are excluded unless their `pluginId` is in this list. `undefined` allows all plugin tools. `[]` allows only built-in (non-plugin) tools. |

## See also {#see-also}

- [Tool interface reference](../tool-interface.md): the index of every section and its page.
