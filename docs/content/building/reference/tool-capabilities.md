---
title: "Tool capabilities reference"
description: "Complete reference for ToolCapabilities, StorageScope, scoped context interfaces, and the error catalog."
kind: reference
audience: developer
slug: tool-capabilities
updated: 2026-11-03
---

The [capability framework](../explanation/why-capabilities.md) gates external access for every [tool](../../getting-started/glossary.md#tool). A tool declares a `ToolCapabilities` object; the framework validates the declaration against the [personality](../../getting-started/glossary.md#personality) policy, resolves scoped context objects at call time, and injects them into `ToolContext`.

## Source {#source}

Types in [`packages/types/src/tool-capabilities.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool-capabilities.ts). Re-exported from `@ethosagent/types`.

Enforcement in [`packages/core/src/capability-validator.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/capability-validator.ts) (registration-time) and [`packages/core/src/capability-resolver.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/capability-resolver.ts) (call-time). Scoped implementations in [`packages/core/src/scoped/`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/).

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `packages/types/src/tool-capabilities.ts` | Type definitions for all capability interfaces. |
| `packages/types/src/tool.ts` | `Tool.capabilities` field; `ToolContext` scoped fields (`kvStore`, `secretsResolver`, `scopedFetch`, `scopedFs`, `scopedProcess`). |
| `packages/core/src/capability-validator.ts` | `validateRegistration` -- registration-time policy check. |
| `packages/core/src/capability-resolver.ts` | `resolveCapabilities` -- call-time context building. |
| `packages/core/src/tool-registry.ts` | `needsBackends` guard; `executeParallel` capability resolution. |
| `packages/core/src/scoped/scoped-fetch.ts` | `ScopedFetchImpl` -- host-gated fetch. |
| `packages/core/src/scoped/scoped-fs.ts` | `ScopedFsImpl` -- path-gated filesystem. |
| `packages/core/src/scoped/scoped-secrets.ts` | `ScopedSecretsImpl` -- ref-gated secrets. |
| `packages/core/src/scoped/scoped-process.ts` | `ScopedProcessImpl` -- binary-gated process spawning. |

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="tool-capabilities"></a>[ToolCapabilities](tool-capabilities/core-and-storage.md#tool-capabilities) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="tool-capabilities-signature"></a>[Signature](tool-capabilities/core-and-storage.md#tool-capabilities-signature) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="tool-capabilities-fields"></a>[Fields](tool-capabilities/core-and-storage.md#tool-capabilities-fields) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="tool-capabilities-notes"></a>[Notes](tool-capabilities/core-and-storage.md#tool-capabilities-notes) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="storage-scope"></a>[StorageScope](tool-capabilities/core-and-storage.md#storage-scope) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="storage-scope-signature"></a>[Signature](tool-capabilities/core-and-storage.md#storage-scope-signature) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="storage-scope-values"></a>[Values](tool-capabilities/core-and-storage.md#storage-scope-values) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="storage-scope-notes"></a>[Notes](tool-capabilities/core-and-storage.md#storage-scope-notes) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="key-value-store"></a>[KeyValueStore](tool-capabilities/core-and-storage.md#key-value-store) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="key-value-store-signature"></a>[Signature](tool-capabilities/core-and-storage.md#key-value-store-signature) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="key-value-store-methods"></a>[Methods](tool-capabilities/core-and-storage.md#key-value-store-methods) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="key-value-store-notes"></a>[Notes](tool-capabilities/core-and-storage.md#key-value-store-notes) | [Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore](tool-capabilities/core-and-storage.md) |
| <a id="scoped-fetch"></a>[ScopedFetch](tool-capabilities/scoped-and-backends.md#scoped-fetch) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-fetch-signature"></a>[Signature](tool-capabilities/scoped-and-backends.md#scoped-fetch-signature) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-fetch-behaviour"></a>[Behaviour](tool-capabilities/scoped-and-backends.md#scoped-fetch-behaviour) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-fetch-notes"></a>[Notes](tool-capabilities/scoped-and-backends.md#scoped-fetch-notes) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-fs"></a>[ScopedFs](tool-capabilities/scoped-and-backends.md#scoped-fs) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-fs-signature"></a>[Signature](tool-capabilities/scoped-and-backends.md#scoped-fs-signature) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-fs-methods"></a>[Methods](tool-capabilities/scoped-and-backends.md#scoped-fs-methods) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-fs-notes"></a>[Notes](tool-capabilities/scoped-and-backends.md#scoped-fs-notes) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-secrets-resolver"></a>[ScopedSecretsResolver](tool-capabilities/scoped-and-backends.md#scoped-secrets-resolver) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-secrets-resolver-signature"></a>[Signature](tool-capabilities/scoped-and-backends.md#scoped-secrets-resolver-signature) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-secrets-resolver-behaviour"></a>[Behaviour](tool-capabilities/scoped-and-backends.md#scoped-secrets-resolver-behaviour) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-secrets-resolver-notes"></a>[Notes](tool-capabilities/scoped-and-backends.md#scoped-secrets-resolver-notes) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-process"></a>[ScopedProcess](tool-capabilities/scoped-and-backends.md#scoped-process) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-process-signature"></a>[Signature](tool-capabilities/scoped-and-backends.md#scoped-process-signature) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-process-behaviour"></a>[Behaviour](tool-capabilities/scoped-and-backends.md#scoped-process-behaviour) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="scoped-process-notes"></a>[Notes](tool-capabilities/scoped-and-backends.md#scoped-process-notes) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="error-catalog"></a>[Error catalog](tool-capabilities/scoped-and-backends.md#error-catalog) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="error-message-format"></a>[Error message format](tool-capabilities/scoped-and-backends.md#error-message-format) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="error-catalog-notes"></a>[Notes](tool-capabilities/scoped-and-backends.md#error-catalog-notes) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="capability-backends"></a>[CapabilityBackends](tool-capabilities/scoped-and-backends.md#capability-backends) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="capability-backends-signature"></a>[Signature](tool-capabilities/scoped-and-backends.md#capability-backends-signature) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="capability-backends-fields"></a>[Fields](tool-capabilities/scoped-and-backends.md#capability-backends-fields) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |
| <a id="capability-backends-notes"></a>[Notes](tool-capabilities/scoped-and-backends.md#capability-backends-notes) | [Tool capabilities: scoped fetch, fs, secrets, process and backends](tool-capabilities/scoped-and-backends.md) |

## See also {#see-also}

- [Why capabilities](../explanation/why-capabilities.md) -- the architectural motivation for the framework
- [Tool isolation model](../explanation/tool-isolation-model.md) -- how the enforcement points work together
- [Tool interface reference](./tool-interface.md) -- `Tool<TArgs>`, `ToolResult`, `ToolContext`
- [Storage interface reference](./storage-interface.md) -- `Storage`, `ScopedStorage`, `BoundaryError`
- [Tool registry reference](./tool-registry.md) -- `DefaultToolRegistry.executeParallel` and the capability wiring
