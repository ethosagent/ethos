---
title: "Publish a plugin: test and publish"
description: "Test a plugin against real registries, document its config and publish it to npm."
kind: how-to
audience: developer
time: "10 min"
updated: 2026-11-03
---

## Task

Test the plugin, document its required config, then build and publish it to npm.

## Result

A tested package on npm that `ethos plugin install <pkg>` loads.

## Prereqs

- Complete [part 1](../publish-a-plugin.md): the package, plugin module and build config exist.

## Steps

### 4. Write tests against real registries

Drive `activate()` against a real `PluginApiImpl` backed by core registries, then assert that the tool the LLM would see is the one you registered. `@ethosagent/plugin-sdk/testing` ships `mockLLM` and `createTestRuntime` for the end-to-end path.

```ts title="src/__tests__/index.test.ts"
import {
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';
import type { ContextInjector } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { activate } from '../index';

describe('myplugin', () => {
  it('registers the greet tool', async () => {
    const injectors: ContextInjector[] = [];
    const tools = new DefaultToolRegistry();
    const api = new PluginApiImpl('myplugin', {
      tools,
      hooks: new DefaultHookRegistry(),
      injectors,
      injectorPluginIds: new Map(),
      personalities: new DefaultPersonalityRegistry(),
    });

    await activate(api);

    expect(tools.toDefinitions().map((d) => d.name)).toContain('greet');
  });
});
```

Run `pnpm test`. A failing test here means the loader will silently skip your plugin in production — fix it before shipping.

### 5. Document required config

Include a `README.md` that lists every env var the plugin reads, every tool it adds, and how to add it to `~/.ethos/config.yaml`:

```yaml
plugins:
  - "@yourscope/ethos-plugin-myplugin"
```

Plugins that touch `terminal` or external network require an entry in the personality's `pluginAllowlist`. Spell that out so users know which personalities get the tool.

### 6. Build and publish

```bash
pnpm build
ls dist/                   # confirm dist/index.js and dist/index.d.ts exist
npm publish --dry-run      # inspect what would ship
npm publish --access public
```

Bump versions per semver: patch for fixes, minor for new tools or hooks, major for breaking changes to a tool's argument schema or to the `ethos` manifest shape.

## Verify

Install the plugin locally and confirm the loader picks it up.

```bash
ethos plugin install @yourscope/ethos-plugin-myplugin
ethos doctor
```

`doctor` lists the loaded plugins, the tools each registered, and any hook subscriptions. Then run one turn:

```bash
ethos chat -q "use the greet tool to say hi to mitesh"
```

A `tool_start` / `tool_end` pair for `greet` in the stream confirms the plugin reached the agent.

## Troubleshoot

**`"<name>" blocked by safety scan: ...`.** — The plugin scanner found a red or yellow finding (suspicious shell usage, undeclared network access, prompt-injection patterns in static strings). Move side effects out of top-level code, declare network hosts under `ethos.permissions.network` in `package.json`, or split the risky path into a user-confirmed code path.

**Plugin loads but the tool never appears to the LLM.** — Tools are gated by both the personality `toolset` and the personality `pluginAllowlist`. Add the tool name to `toolset.yaml` and the plugin id to `pluginAllowlist` for the personalities that should see it.
