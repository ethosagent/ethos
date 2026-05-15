---
title: "Add a network tool"
description: "Declare network and secrets capabilities, use ctx.scopedFetch and ctx.secretsResolver to make API calls the framework can audit and enforce."
kind: how-to
audience: developer
slug: add-a-network-tool
updated: 2026-05-14
---

## Task

Build a [tool](../../getting-started/glossary.md#tool) that calls an external API, using the capability framework to declare which hosts it contacts and which secrets it needs. The framework resolves these declarations into scoped, auditable accessors at runtime.

## Result

A tool whose network and secrets usage is fully declared in `capabilities`. At execution time the framework provides `ctx.scopedFetch` (host-gated) and `ctx.secretsResolver` (ref-gated) instead of raw `fetch()` or `process.env`. The [personality](../../getting-started/glossary.md#personality) controls the final network reach via intersection.

## Prereqs

- `@ethosagent/types` (for `Tool`, `ToolResult`, `ToolCapabilities`).
- An API endpoint to call and the secret name(s) the backend stores the credential under.
- A personality with `safety.network.allow` covering the target host (or no `safety.network` block, which defaults to open public internet).

## Steps

### 1. Declare capabilities

Every tool that touches the network or reads secrets must declare those needs in its `capabilities` object. The framework refuses to execute a tool with non-empty capabilities when no capability backends are wired (fail-closed).

```ts title="src/weather-tool.ts"
import type { Tool, ToolResult } from '@ethosagent/types';

export const weatherTool: Tool = {
  name: 'weather',
  description: 'Look up current weather for a city.',
  toolset: 'web',
  capabilities: {
    network: { allowedHosts: ['api.openweathermap.org'] },
    secrets: ['providers/openweather/apiKey'],
  },
  schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    // ... (see step 2 and 3)
  },
};
```

`network.allowedHosts` is a list of exact hostnames. Subdomain wildcards are not supported here -- they belong in the personality's `safety.network.allow`. The framework creates a `ScopedFetchImpl` that rejects any fetch to a host not in the resolved set.

`secrets` is a list of opaque ref strings. They name entries in the secrets backend, not environment variable names. The framework creates a `ScopedSecretsImpl` that throws `SECRET_NOT_DECLARED` if the tool asks for a ref it did not declare.

### 2. Use ctx.scopedFetch instead of global fetch

Inside `execute`, use `ctx.scopedFetch.fetch()` for all HTTP calls. It enforces the host allowlist before dispatching.

```ts
async execute(args, ctx): Promise<ToolResult> {
  const { city } = args as { city: string };
  if (!city) return { ok: false, error: 'city is required', code: 'input_invalid' };

  const net = ctx.scopedFetch;
  const secrets = ctx.secretsResolver;
  if (!net || !secrets) {
    return { ok: false, error: 'Capability backends not configured', code: 'not_available' };
  }

  const apiKey = await secrets.get('providers/openweather/apiKey');
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;

  const response = await net.fetch(url, { signal: ctx.abortSignal });
  if (!response.ok) {
    return { ok: false, error: `API ${response.status}`, code: 'execution_failed' };
  }
  const data = (await response.json()) as { main: { temp: number }; weather: Array<{ description: string }> };
  return { ok: true, value: `${city}: ${data.main.temp}C, ${data.weather[0]?.description ?? ''}` };
},
```

Calling `globalThis.fetch()` directly bypasses the host gate. The framework cannot audit or block it. Always route through `ctx.scopedFetch`.

### 3. Use ctx.secretsResolver instead of process.env

`ctx.secretsResolver.get(ref)` reads a credential by its declared ref string. It throws `SECRET_NOT_DECLARED` if the ref is not in the tool's `secrets` array.

```ts
const apiKey = await secrets.get('providers/openweather/apiKey');
```

Do not fall back to `process.env`. The ref-gating lets the framework answer "which secrets can this tool read?" without running it.

### 4. Understand the '*' inherit sentinel

A tool that should work with whatever hosts the personality allows can declare `allowedHosts: ['*']`. The resolver replaces `*` with the personality's `safety.network.allow` list at runtime.

```ts
capabilities: {
  network: { allowedHosts: ['*'] },
},
```

When the personality has `safety.network.allow: ['api.github.com', '*.openai.com']`, the tool gets a `ScopedFetchImpl` scoped to exactly those hosts. When no personality network config exists, `*` resolves to an empty set -- the tool can reach nothing. Use `*` for generic tools where the personality defines which APIs are reachable.

### 5. Understand personality network intersection

When a tool declares specific hosts (not `*`), the framework intersects them with the personality's `safety.network.allow`. A host in the tool's list survives only if the personality's allow list covers it (exact match or wildcard pattern like `*.example.com`).

| Tool declares | Personality allows | Resolved set |
|---|---|---|
| `['api.exa.ai']` | `['api.exa.ai', 'api.openai.com']` | `{'api.exa.ai'}` |
| `['api.exa.ai']` | `['*.exa.ai']` | `{'api.exa.ai'}` |
| `['api.exa.ai']` | `['api.openai.com']` | `{}` (tool gets nothing) |
| `['api.exa.ai']` | undefined (no block) | `{'api.exa.ai'}` (tool's own declaration) |
| `['*']` | `['api.github.com']` | `{'api.github.com'}` |

The intersection is computed once per tool execution in `resolveCapabilities()` (`packages/core/src/capability-resolver.ts`). A fetch to a host outside the resolved set throws `HOST_NOT_ALLOWED`.

## Verify

Register the tool and execute it:

```bash
pnpm check
```

Write a test that confirms the scoped accessors are wired:

```ts
import { DefaultToolRegistry } from '@ethosagent/core';

const registry = new DefaultToolRegistry(backends);
registry.register(weatherTool);
const results = await registry.executeParallel(
  [{ toolCallId: 'c1', name: 'weather', args: { city: 'London' } }],
  baseCtx,
);
expect(results[0]?.result.ok).toBe(true);
```

## Troubleshoot

**`HOST_NOT_ALLOWED: api.example.com is not in the declared allowedHosts`.** -- The tool is fetching a host it did not declare. Add the hostname to `capabilities.network.allowedHosts`.

**`SECRET_NOT_DECLARED: providers/foo/key is not in the tool's declared secrets`.** -- The ref string does not match any entry in `capabilities.secrets`. Check for typos; the match is exact.

**`Capability backends not configured`.** -- `ctx.scopedFetch` or `ctx.secretsResolver` is undefined. The tool declared capabilities but the registry was constructed without `CapabilityBackends`. In production wiring this means the secrets backend or the personality network allow list is not configured.

**Tool passes in tests but gets an empty resolved host set in production.** -- The personality's `safety.network.allow` does not cover the tool's declared hosts. Add the host (or a wildcard pattern) to the personality's config.
