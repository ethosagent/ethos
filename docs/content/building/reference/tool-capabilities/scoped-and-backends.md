---
title: "Tool capabilities: scoped fetch, fs, secrets, process and backends"
description: "Scoped fetch, fs, secrets and process capabilities, errors, backends."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

The scoped network, filesystem, secret and process capabilities, plus the errors and backends behind them. Part of the [Tool capabilities reference](../tool-capabilities.md).

## ScopedFetch {#scoped-fetch}

### Signature {#scoped-fetch-signature}

```ts
import type { ScopedFetch } from '@ethosagent/types';

export interface ScopedFetch {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}
```

### Behaviour {#scoped-fetch-behaviour}

The implementation (`ScopedFetchImpl` in `packages/core/src/scoped/scoped-fetch.ts`) parses the URL, extracts the hostname, and checks it against the resolved host set (intersection of the tool's `allowedHosts` and the personality's `safety.network.allow`). If the host is not in the set, the call throws with `HOST_NOT_ALLOWED`. Otherwise it delegates to `globalThis.fetch`.

Host matching supports:
- Exact match: `'api.github.com'` matches `api.github.com`.
- Wildcard: `'*'` matches any host.
- Subdomain wildcard: `'*.github.com'` matches `api.github.com` and `raw.github.com` but not `github.com` itself.

### Notes {#scoped-fetch-notes}

- Injected into `ToolContext.scopedFetch` when the tool declares `network`. Absent otherwise.
- The resolved host set may be smaller than the tool's declared set. A tool declaring `['api.github.com', 'api.stripe.com']` under a personality that allows `['*.github.com']` gets a `ScopedFetch` that permits only `api.github.com`.

## ScopedFs {#scoped-fs}

### Signature {#scoped-fs-signature}

```ts
import type { ScopedFs } from '@ethosagent/types';

export interface ScopedFs {
  read(path: string): Promise<string>;
  write(path: string, content: string | Buffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}
```

### Methods {#scoped-fs-methods}

| Method | Returns | Description |
|---|---|---|
| `read(path)` | `string` | Read utf-8 text. Throws `PATH_NOT_REACHABLE` if the path is outside the declared read set. Throws if the file does not exist. |
| `write(path, content)` | `void` | Write utf-8 text or a Buffer. Throws `PATH_NOT_REACHABLE` if the path is outside the declared write set. |
| `exists(path)` | `boolean` | Check existence. Throws `PATH_NOT_REACHABLE` if the path is outside the declared read set. |
| `list(path)` | `string[]` | List directory children. Throws `PATH_NOT_REACHABLE` if the path is outside the declared read set. |

### Notes {#scoped-fs-notes}

- Injected into `ToolContext.scopedFs` when the tool declares `fs_reach`. Absent otherwise.
- The implementation (`ScopedFsImpl` in `packages/core/src/scoped/scoped-fs.ts`) resolves paths via `node:path.resolve` and `normalize` before checking. Relative paths are resolved against `process.cwd()`.
- Delegates to the `Storage` interface, not to raw `node:fs`. The same `Storage` abstraction powers `ScopedStorage` from the pre-existing filesystem boundary.
- `ScopedFs` is distinct from `ScopedStorage`. `ScopedStorage` (from `@ethosagent/storage-fs`) is the personality-level decorator on the full `Storage` interface. `ScopedFs` is the capability-gated subset exposed to individual tools.

## ScopedSecretsResolver {#scoped-secrets-resolver}

### Signature {#scoped-secrets-resolver-signature}

```ts
import type { ScopedSecretsResolver, SecretRef } from '@ethosagent/types';

export interface ScopedSecretsResolver {
  get(ref: SecretRef): Promise<string>;
}
```

### Behaviour {#scoped-secrets-resolver-behaviour}

The implementation (`ScopedSecretsImpl` in `packages/core/src/scoped/scoped-secrets.ts`) checks the requested `ref` against the tool's declared `secrets` set. If the ref is not declared, the call throws with `SECRET_NOT_DECLARED`. Otherwise it delegates to the configured secrets backend.

### Notes {#scoped-secrets-resolver-notes}

- Injected into `ToolContext.secretsResolver` when the tool declares `secrets` and a `secretsBackend` is configured. Absent otherwise.
- The secrets backend is a function `(ref: SecretRef) => Promise<string>` provided via `CapabilityBackends.secretsBackend`. The framework does not mandate where secrets are stored -- the backend is a wiring decision.

## ScopedProcess {#scoped-process}

### Signature {#scoped-process-signature}

```ts
import type { ScopedProcess, SpawnOpts, ProcessResult } from '@ethosagent/types';

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ScopedProcess {
  spawn(binary: string, args: string[], opts?: SpawnOpts): Promise<ProcessResult>;
}
```

### Behaviour {#scoped-process-behaviour}

The implementation (`ScopedProcessImpl` in `packages/core/src/scoped/scoped-process.ts`) checks the requested `binary` against the tool's declared `allowedBinaries` set. Wildcard (`'*'`) permits any binary. If the binary is not in the set, the call throws with `BINARY_NOT_ALLOWED`. Otherwise it spawns the process via `node:child_process.spawn`.

### Notes {#scoped-process-notes}

- Injected into `ToolContext.scopedProcess` when the tool declares `process`. Absent otherwise.
- `opts.env` is merged with `process.env` -- the tool's declared env vars are additive, not replacing.
- `opts.timeout` is passed directly to `child_process.spawn`'s `timeout` option. The child is killed if it exceeds the timeout.

## Error catalog {#error-catalog}

All errors thrown by scoped context implementations use a stable prefix in the error message. Catch by `message.startsWith(code)` or by checking the `Error.message` directly.

| Code | Thrown by | When |
|---|---|---|
| `HOST_NOT_ALLOWED` | `ScopedFetchImpl` | The requested hostname is not in the resolved allowedHosts set. |
| `SECRET_NOT_DECLARED` | `ScopedSecretsImpl` | The requested secret ref is not in the tool's declared secrets set. |
| `PATH_NOT_REACHABLE` | `ScopedFsImpl` | The requested path is not covered by the tool's declared fs_reach (read or write). |
| `BINARY_NOT_ALLOWED` | `ScopedProcessImpl` | The requested binary is not in the tool's declared allowedBinaries set. |

### Error message format {#error-message-format}

Each error follows the pattern `<CODE>: <detail>`:

```
HOST_NOT_ALLOWED: api.stripe.com is not in the declared allowedHosts
SECRET_NOT_DECLARED: STRIPE_KEY is not in the tool's declared secrets
PATH_NOT_REACHABLE: read not permitted for /etc/passwd
BINARY_NOT_ALLOWED: rm is not in the declared allowedBinaries
```

### Notes {#error-catalog-notes}

- These errors propagate to `ToolResult` as `{ ok: false, code: 'execution_failed', error: err.message }` via the `executeParallel` catch handler. The LLM sees the full error message.
- Registration-time validation errors (`CapabilityValidationError`) are a separate type with `{ tool, capability, message }` fields. They are not thrown -- they are returned as an array from `validateRegistration` and `validateToolsForPersonality`.

## CapabilityBackends {#capability-backends}

### Signature {#capability-backends-signature}

```ts
import type { CapabilityBackends } from '@ethosagent/core';

export interface CapabilityBackends {
  kvStoreFactory?: (tool: string, scopeId: string) => KeyValueStore;
  secretsBackend?: (ref: SecretRef) => Promise<string>;
  storage?: Storage;
  personalityFsReach?: (personalityId?: string) => { read: string[]; write: string[] };
  personalityNetworkPolicy?: (personalityId?: string) => NetworkPolicy;
}
```

### Fields {#capability-backends-fields}

| Field | Type | Description |
|---|---|---|
| `kvStoreFactory` | `(tool, scopeId) => KeyValueStore` | Factory for scoped key-value stores. Called once per tool per turn. |
| `secretsBackend` | `(ref) => Promise<string>` | Resolves a secret ref to its value. Called by `ScopedSecretsImpl`. |
| `storage` | `Storage` | Filesystem abstraction passed to `ScopedFsImpl`. |
| `personalityFsReach` | `(personalityId?) => { read: string[]; write: string[] }` | Resolves the fs_reach of the personality running the turn. Used to resolve `'from-personality'` declarations and to intersect with tool-declared paths. |
| `personalityNetworkPolicy` | `(personalityId?) => NetworkPolicy` | Resolves the network policy of the personality running the turn. Its `allow` list is intersected with tool-declared hosts. |

### Notes {#capability-backends-notes}

- Passed to `DefaultToolRegistry` at construction. Shared across all tool executions.
- If absent, tools that declare real capabilities (`needsBackends` returns true) fail closed with `not_available`.
- `personalityFsReach` and `personalityNetworkPolicy` are resolvers, called per tool execution with the id of the personality running that call. They are never stored values: a stored value freezes the boundary at process start, so an on-disk config edit -- or a personality that is not the default -- resolves against the wrong policy.

## See also {#see-also}

- [Tool capabilities reference](../tool-capabilities.md): the index of every section and its page.
