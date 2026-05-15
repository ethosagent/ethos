---
title: "Why capabilities"
description: "The architectural insight behind the tool capability framework: declarative capabilities, framework-enforced, no escape hatches in tool code."
kind: explanation
audience: developer
slug: why-capabilities
updated: 2026-05-14
---

## Context

A [tool](../../getting-started/glossary.md#tool) in Ethos runs user-requested work: read a file, fetch a URL, look up a secret, spawn a subprocess. Each of those actions touches an external surface -- the filesystem, the network, the secrets store, a process boundary. How a framework accounts for which tools touch which surfaces determines whether a security review is tractable.

Before the capability framework, tools imported their dependencies directly. A tool that needed to fetch a URL called `globalThis.fetch`. A tool that read a file imported `node:fs/promises`. A tool that needed an API key read `process.env.SOME_KEY`. The code worked. The problem was not correctness -- it was auditability.

This page explains why the framework moved from "tools import what they need" to "tools declare what they touch, and the framework provides scoped access at call time."

## Discussion

### The audit problem: grep is not a security review

When a tool imports `node:fs/promises` directly, the only way to know which paths it reads is to read its source. When ten tools do that, a reviewer reads ten implementations. When a plugin ships a tool, the reviewer reads code they did not write. When the plugin updates, they read it again.

The same applies to network access (`fetch` with which hosts), secrets (`process.env` with which keys), and subprocesses (`child_process.spawn` with which binaries). Each direct import scatters the "what does this tool touch" answer across the implementation. The answer is always available -- you can grep -- but it is never in one place.

A [personality](../../getting-started/glossary.md#personality) makes this worse. A personality restricts which tools are available (`toolset.yaml`) and which filesystem paths are reachable (`fs_reach`). But if a tool bypasses the framework and reaches for raw `node:fs`, the personality boundary is decorative. The toolset says "you may use `read_file`" but has no way to enforce "and `read_file` may only touch these paths" unless the framework mediates the access.

### The fix: lift the declaration out of the implementation

The capability framework introduces a single typed field on every tool: `capabilities: ToolCapabilities`. The field is a static declaration of what the tool needs from the outside world:

```typescript
const myTool: Tool = {
  name: 'fetch_weather',
  capabilities: {
    network: { allowedHosts: ['api.weather.gov'] },
    secrets: ['WEATHER_API_KEY'],
  },
  // ...
};
```

The declaration is data, not code. It does not import anything. It does not call anything. It says: "this tool will need to make HTTP requests to `api.weather.gov` and will need the secret named `WEATHER_API_KEY`." That is the entire surface area, readable from the tool's definition without opening `execute`.

Five categories cover the external surfaces a tool can touch:

| Category | Declaration shape | What it gates |
|---|---|---|
| `network` | `{ allowedHosts: string[] }` | Which hosts the tool may fetch |
| `secrets` | `SecretRef[]` | Which secret names the tool may read |
| `storage` | `{ scope: StorageScope; kind: 'kv' }` | Key-value storage with a scoped lifecycle |
| `fs_reach` | `{ read?: string[]; write?: string[] }` | Filesystem paths the tool may read/write |
| `process` | `{ allowedBinaries: string[] }` | Which binaries the tool may spawn |

A tool that declares `capabilities: {}` touches nothing external. The framework provides no scoped context and the tool runs in a closed environment. A tool that omits `capabilities` entirely is legacy -- it runs the same way, but the framework cannot mediate its access.

### The three enforcement points

The declaration would be prose without enforcement. The framework turns it into a contract at three points in the tool lifecycle.

**Registration-time validation.** `validateRegistration` in `packages/core/src/capability-validator.ts` runs when a tool is registered against a personality. It checks that every host in the tool's `network.allowedHosts` is covered by the personality's `safety.network.allow` list, and that every path in the tool's `fs_reach` is covered by the personality's `fs_reach`. A mismatch is a `CapabilityValidationError` -- the tool is asking for more than the personality permits. The error is surfaced before the tool ever runs.

**Call-time context building.** `resolveCapabilities` in `packages/core/src/capability-resolver.ts` runs at the start of every tool execution inside `executeParallel`. It reads the tool's declaration, intersects it with the personality's policy and the available backends, and produces scoped context objects: a `ScopedFetch` that only permits declared hosts, a `ScopedSecretsResolver` that only permits declared secret refs, a `ScopedFs` that only permits declared paths, a `ScopedProcess` that only permits declared binaries, a `KeyValueStore` scoped to the declared storage lifecycle. These objects are merged into the `ToolContext` the tool receives.

**Fail-closed guard.** `needsBackends` in `packages/core/src/tool-registry.ts` checks whether a tool's capabilities require backends (network, secrets, storage, fs_reach, or process). If the tool declares real capabilities but the registry was constructed without `CapabilityBackends`, the tool call fails with `not_available` before `execute` runs. The tool cannot silently fall through to an unmediated path.

The three points form a pipeline: validate the declaration fits the personality policy, build scoped access from the declaration, refuse to run if the infrastructure is missing. A tool that passes all three gets exactly the access it declared, no more.

### What the capability framework buys

**Security review from declarations.** A reviewer reads `capabilities` on each tool and knows the external surface. The personality's policy sets the ceiling. The intersection is the actual access. No source-reading required for the access audit.

**Personality policy enforcement.** A personality that sets `safety.network.allow: ['*.github.com']` means no tool in that personality can reach hosts outside that pattern, regardless of what the tool's code might try. The framework mediates the access; the tool never sees raw `fetch`.

**Plugin ecosystem viability.** A third-party tool shipped as a plugin declares its capabilities in the same typed field. The host personality decides whether those capabilities fit its policy. The plugin author does not need to be trusted with raw `node:fs` -- they get a `ScopedFs` that enforces the personality's `fs_reach`. This is the difference between "trust the plugin author not to be malicious" and "trust the framework to enforce the declared boundary."

**Fail-closed by default.** A tool that declares `network` but runs in a registry without a network backend gets a clear error, not a silent pass-through. The guard catches misconfiguration at the framework level rather than producing a confusing runtime error inside the tool.

### What the capability framework does not do

**Runtime sandboxing.** The framework does not run tools in a separate process, a V8 isolate, or a container. A tool that calls `globalThis.fetch` directly -- bypassing `ctx.scopedFetch` -- reaches the real network. The framework provides scoped access and a lint rule that catches direct imports; it does not provide process-level isolation.

**Third-party library policing.** A tool that depends on a library, and that library calls `node:fs` internally, is not caught by the framework. The capability boundary is at the tool's `execute` entry point. The framework cannot see inside a dependency's call stack.

**`isAvailable` environment reads.** The `isAvailable` gate on a tool often reads `process.env` to check for an API key. This is outside the capability framework -- it runs before the tool is ever called and before capabilities are resolved. The `isAvailable` pattern predates the capability framework and is intentionally not mediated by it.

The capability framework is a typed, declarative, framework-enforced contract over the external surfaces a tool touches. It is not a sandbox. The security model is: declare what you need, get exactly that, and the framework refuses to provide more. The code-level enforcement is strong enough to make personality policy real. The gaps -- direct imports, library internals, `isAvailable` env reads -- are documented limits, not design flaws.

## Trade-offs

**Every tool must declare capabilities.** The `capabilities` field is required on `Tool`. A tool that touches no external surface declares `capabilities: {}`. A tool migrated from before the framework must add the field. The cost is one declaration per tool; the benefit is the audit surface.

**The framework must wire backends.** `CapabilityBackends` must be provided to `DefaultToolRegistry` for any tool that declares real capabilities. Tests that construct a registry without backends cannot run capability-bearing tools. The fix is straightforward -- wire test backends -- but it is an additional setup step.

**No runtime isolation.** A malicious tool can bypass the scoped context by importing `node:fs` directly. The lint rule catches this at review time, not at runtime. A project that needs process-level isolation must layer it on top (e.g. running plugins in a subprocess). The capability framework provides the declaration and mediation layer that such a sandbox would consume.

## See also

- [Tool isolation model](tool-isolation-model.md) -- the enforcement points in detail
- [Tool capabilities reference](../reference/tool-capabilities.md) -- every type, interface, and error code
- [Tool interface reference](../reference/tool-interface.md) -- `Tool<TArgs>`, `ToolResult`, `ToolContext`
- [Why does AgentLoop receive every dependency at construction?](injection-at-construction.md) -- how backends flow into the registry
- [Storage interface reference](../reference/storage-interface.md) -- `ScopedStorage`, the pre-existing pattern the capability framework generalises
