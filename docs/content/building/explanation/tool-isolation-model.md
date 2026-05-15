---
title: "Tool isolation model"
description: "What a tool cannot do, why each enforcement point matters, and the boundary between framework-provided and capability-gated surfaces."
kind: explanation
audience: developer
slug: tool-isolation-model
updated: 2026-05-14
---

## Context

The [capability framework](why-capabilities.md) introduces a typed declaration on every tool: `capabilities: ToolCapabilities`. This page is about how the framework turns that declaration into enforcement -- what a tool can and cannot do at each stage of its lifecycle, and where the enforcement model has deliberate gaps.

The model has five capability categories, three enforcement points, and a source-level backstop. Each piece exists because the one before it is not sufficient alone.

## Discussion

### Five capability categories

Every external surface a tool can touch maps to one of five categories in the `ToolCapabilities` interface:

**`network`** gates HTTP access. The tool declares which hosts it needs (`allowedHosts`); the framework provides a `ScopedFetch` that refuses requests to any other host. The error is `HOST_NOT_ALLOWED`.

**`secrets`** gates credential access. The tool declares which secret refs it needs (e.g. `'WEATHER_API_KEY'`); the framework provides a `ScopedSecretsResolver` that refuses any ref not in the declared set. The error is `SECRET_NOT_DECLARED`.

**`storage`** gates key-value persistence. The tool declares a `StorageScope` (`'tool-private'`, `'session'`, or `'personality'`); the framework provides a `KeyValueStore` whose namespace is derived from the scope. A `tool-private` store is keyed to the tool name; a `session` store is keyed to the session id; a `personality` store is keyed to the personality id. The tool never picks its own namespace.

**`fs_reach`** gates filesystem access. The tool declares which paths it needs for read and write, or defers to the personality via `'from-personality'`; the framework provides a `ScopedFs` that checks every path against the declared set. The error is `PATH_NOT_REACHABLE`.

**`process`** gates subprocess spawning. The tool declares which binaries it may invoke (`allowedBinaries`); the framework provides a `ScopedProcess` that refuses any binary not in the set. The error is `BINARY_NOT_ALLOWED`.

A tool that declares none of these categories (`capabilities: {}`) touches nothing external. The framework provides no scoped context and the tool runs with only the base `ToolContext`.

### Enforcement point 1: registration-time validation

`validateRegistration` in `packages/core/src/capability-validator.ts` runs when a tool is checked against a [personality](../../getting-started/glossary.md#personality). It answers: does this tool's declaration fit inside the personality's policy?

The check is structural. For `network`, every host in the tool's `allowedHosts` must be covered by a pattern in the personality's `safety.network.allow` list. For `fs_reach`, every path the tool declares must be a prefix match against the personality's `fs_reach.read` or `fs_reach.write`. A mismatch produces a `CapabilityValidationError` with the tool name, the capability category, and a message explaining the gap.

Registration-time validation is the earliest possible failure. A tool that asks for `api.stripe.com` but the personality only allows `*.github.com` is caught before the tool ever runs. The error is data -- the caller can display it, log it, or use it to reject the registration programmatically.

The check does not cover `secrets`, `storage`, or `process` at registration time. Secrets are resolved by a backend that may not be available at registration; the personality does not declare a secrets allowlist. Storage scope is always valid structurally. Process binaries are checked at call time. Registration-time validation covers the categories where the personality has an explicit policy surface.

### Enforcement point 2: call-time context building

`resolveCapabilities` in `packages/core/src/capability-resolver.ts` runs inside `executeParallel` at the start of every tool call. It reads the tool's declaration, intersects it with the personality's runtime policy and the available backends, and builds scoped context objects.

The intersection matters. A tool that declares `network: { allowedHosts: ['api.github.com', 'api.stripe.com'] }` and a personality that allows `['*.github.com']` gets a `ScopedFetch` whose resolved host set is `{'api.github.com'}` -- the intersection of declared and permitted. The tool asked for Stripe; the personality did not allow it; the scoped context does not include it.

For `fs_reach`, the `'from-personality'` sentinel defers the path set entirely to the personality. A tool that declares `fs_reach: { read: 'from-personality' }` gets a `ScopedFs` whose read paths are whatever the personality's `fs_reach.read` lists. This is the right shape for generic file tools (`read_file`, `search_files`) that should respect the personality's boundary without hardcoding paths.

For `storage`, the resolver computes the scope id from the declared `StorageScope` and the runtime identifiers (`sessionId`, `personalityId`). The tool never constructs its own scope id.

The scoped objects are merged into the `ToolContext` via `Object.assign`. The tool's `execute` receives the enriched context and uses `ctx.scopedFetch`, `ctx.secretsResolver`, `ctx.scopedFs`, `ctx.scopedProcess`, or `ctx.kvStore` instead of reaching for raw dependencies. Each scoped object enforces the intersection at every call.

### Enforcement point 3: the fail-closed guard

`needsBackends` in `packages/core/src/tool-registry.ts` is a one-line function:

```typescript
function needsBackends(caps: ToolCapabilities): boolean {
  return !!(caps.network || caps.secrets || caps.storage || caps.fs_reach || caps.process);
}
```

It returns true when a tool's capabilities require framework infrastructure to resolve. The guard fires inside `executeParallel`: if a tool needs backends but the `DefaultToolRegistry` was constructed without `CapabilityBackends`, the call fails with `not_available` and the message `"Tool <name> declares capabilities but no capability backends are configured"`.

This is the fail-closed property. Without it, a registry constructed without backends would silently skip capability resolution and run the tool with an un-enriched context. The tool would find `ctx.scopedFetch` undefined, might fall back to raw `fetch`, and the capability boundary would be decorative. The guard prevents that: no backends means no execution for tools that need them.

The guard distinguishes `capabilities: {}` (opt-in to the framework, no external surfaces) from a tool with real capability entries. The former runs without backends. The latter requires them.

### The lint rule: source-level backstop

The enforcement points above are runtime. A tool author who writes `import fs from 'node:fs/promises'` inside a tool's `execute` bypasses all three -- the scoped context is available, but the tool ignores it and reads the filesystem directly.

The lint rule is the source-level backstop. It flags direct imports of `node:fs`, `node:fs/promises`, `node:child_process`, and raw `globalThis.fetch` in tool implementation files. The rule does not run at runtime; it runs at review time (CI lint pass, editor integration). It catches the bypass before the code ships.

The rule is not airtight. A tool can call a helper function in another file that imports `node:fs`. A tool can use a third-party library that calls `fetch` internally. The lint rule catches the direct case -- the tool file itself importing a raw dependency -- and relies on code review for the transitive cases.

### What the model does NOT enforce

**Third-party library bypass.** A tool that depends on `axios` and `axios` calls `globalThis.fetch` internally is not caught. The capability boundary is at the `execute` entry point. The framework cannot see inside a dependency's implementation. If a library must be constrained, the tool author must use the scoped context and avoid libraries that make their own network calls.

**`isAvailable` environment reads.** The `isAvailable` gate on a tool runs before the capability framework. It typically reads `process.env` to check for the presence of an API key or external binary. This read is outside the capability model -- it happens at tool-list-building time, not at call time, and it is a boolean gate, not an access request. The capability framework does not mediate it.

**Cross-tool collusion.** Two tools running in the same turn share the same `ToolContext` base (different scoped objects, but the same `sessionId`, `workingDir`, etc.). The framework does not isolate tools from each other within a turn. A tool cannot read another tool's `ScopedFetch` (it is a separate instance), but both tools see the same `workingDir` and `storage`.

**Process-level isolation.** Tools run in the same Node.js process as the agent loop. A tool that calls `process.exit(1)` kills the agent. The capability framework is an application-level access-mediation layer, not a sandbox. Projects that need process isolation layer it on top (e.g. running plugin tools in a subprocess).

## Trade-offs

**Three enforcement points, not one.** Registration-time validation, call-time resolution, and the fail-closed guard could be a single "run or reject" decision. Splitting them into three points means three places to understand and three places where bugs could live. The benefit: each catches a different failure mode. Registration catches policy mismatches before the turn starts. Resolution builds scoped access. The guard catches infrastructure misconfiguration. Collapsing them would lose the early feedback from registration-time validation.

**The lint rule is advisory, not blocking.** A project that does not run the lint rule in CI gets no source-level enforcement. The capability framework degrades to runtime-only mediation: scoped context is available, but no one checks whether the tool uses it. The mitigation is making the lint rule part of `pnpm check`, which is the pre-ship gate.

**No transitive dependency enforcement.** The framework trusts that a tool's dependencies do not bypass the scoped context. This is a real gap for plugins that pull in libraries with their own I/O. The mitigation today is code review and the lint rule on the tool file itself. Process-level isolation would close the gap at a significant complexity cost.

## See also

- [Why capabilities](why-capabilities.md) -- the architectural motivation for the framework
- [Tool capabilities reference](../reference/tool-capabilities.md) -- every type, interface, and error code
- [Tool interface reference](../reference/tool-interface.md) -- `Tool<TArgs>`, `ToolResult`, `ToolContext`
- [Storage interface reference](../reference/storage-interface.md) -- `ScopedStorage`, the pre-existing filesystem boundary
- [Personality governance](personality-governance.md) -- the schema-freeze rule that protects the personality contract the capability framework enforces
