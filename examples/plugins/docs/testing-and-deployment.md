# Plugin examples: testing, deployment, CI and reference

[Back to the plugin examples](../README.md)

## Testing

### Unit tests

Test each function in isolation. No real LLM, no network, no file system.

```typescript
import { describe, expect, it } from 'vitest';
import { myTool } from '../index';

const ctx = {
  sessionId: 'test', sessionKey: 'cli:test', platform: 'cli',
  workingDir: '/tmp', currentTurn: 1, messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {}, resultBudgetChars: 80_000,
};

it('returns ok for valid input', async () => {
  const result = await myTool.execute({ query: 'hello' }, ctx);
  expect(result.ok).toBe(true);
});

it('returns not_available when API key missing', () => {
  const saved = process.env.MY_API_KEY;
  delete process.env.MY_API_KEY;
  expect(myTool.isAvailable?.()).toBe(false);
  if (saved) process.env.MY_API_KEY = saved;
});
```

### Integration tests

Load the plugin into real registries, verify registration and cleanup.

```typescript
import { DefaultHookRegistry, DefaultToolRegistry, DefaultPersonalityRegistry } from '@ethosagent/core';
import { createTestRuntime, mockLLM } from '@ethosagent/plugin-sdk/testing';

const registries = {
  tools: new DefaultToolRegistry(),
  hooks: new DefaultHookRegistry(),
  injectors: [],
  personalities: new DefaultPersonalityRegistry(),
};

// See any example's integration.test.ts for the makeApi() helper
await activate(makeApi('my-plugin', registries));

// Assert registration
expect(registries.tools.get('my_tool')).toBeDefined();

// Run a full agent turn with mockLLM
const loop = createTestRuntime({ llm: mockLLM(['Result here']), tools: registries.tools });
const events = [];
for await (const event of loop.run('Do something')) events.push(event.type);
expect(events).toContain('done');

// Assert cleanup
api._cleanup();
expect(registries.tools.get('my_tool')).toBeUndefined();
```

### Running tests

```bash
# Inside a plugin directory
pnpm test

# From workspace root (runs all plugins)
pnpm test
```

---

## Deployment

### Option 1: Local directory plugin (development / personal use)

No build step needed. Ethos loads `.ts` files directly via tsx.

```bash
# User-global (available in all projects)
cp -r my-plugin ~/.ethos/plugins/

# Project-local (checked into the repo, used by this project only)
mkdir -p .ethos/plugins
cp -r my-plugin .ethos/plugins/
```

Restart `ethos` — plugin is active.

### Option 2: npm package (sharing with others)

**1. Build the plugin:**

```bash
# tsup bundles TypeScript to ESM
pnpm add -D tsup
```

Add to `package.json`:
```json
{
  "scripts": { "build": "tsup src/index.ts --format esm --dts" },
  "main": "./dist/index.js",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } }
}
```

```bash
pnpm build
```

**2. Publish:**

```bash
npm publish
# or for scoped packages:
npm publish --access public
```

**3. Install:**

```bash
pnpm add ethos-plugin-my-plugin
```

The plugin loader auto-discovers npm packages named `ethos-plugin-*` with `"ethos": { "type": "plugin" }` in their `package.json`.

### Option 3: Monorepo plugin (this repo)

If you're contributing a plugin to the Ethos monorepo itself:

```
plugins/
└── my-plugin/
    ├── package.json
    └── src/index.ts
```

It's automatically included in `pnpm-workspace.yaml` and picked up by `pnpm test`.

---

## CI checklist

Add these to your plugin's CI pipeline:

```yaml
- pnpm install
- pnpm typecheck    # zero TypeScript errors
- pnpm test        # all tests pass
- node -e "import('./dist/index.js').then(m => { if (!m.activate) throw new Error('no activate') })"
```

Validate the `package.json` contract:

```typescript
import { validatePluginPackageJson } from '@ethosagent/plugin-contract';
const result = validatePluginPackageJson(require('./package.json'));
if (!result.valid) throw new Error(result.errors.join('\n'));
```

---

## Security

- Plugins run in the **same process** as the agent. A malicious plugin has full Node.js access.
- Only install plugins from sources you trust.
- Use `before_tool_call` modifying hooks to build safety layers (see `example-safety-adapter/`).
- `isAvailable()` is the right place to check env vars — if missing, the tool is hidden from the LLM entirely, not just erroring at call time.
- Never log API keys or secrets in tool results — the LLM reads every value.

---

## Reference

| Import | What you get |
|---|---|
| `@ethosagent/plugin-sdk` | `EthosPluginApi`, `EthosPlugin`, `PluginApiImpl`, type re-exports |
| `@ethosagent/plugin-sdk/tool-helpers` | `ok()`, `err()`, `defineTool<TArgs>()` |
| `@ethosagent/plugin-sdk/testing` | `mockLLM()`, `mockTool()`, `createTestRuntime()` |
| `@ethosagent/plugin-contract` | `validatePluginPackageJson()`, `isEthosPlugin()` |
| `@ethosagent/core` | `DefaultToolRegistry`, `DefaultHookRegistry`, `DefaultPersonalityRegistry` |
