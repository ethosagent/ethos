# Plugin examples

Worked plugin packages you can copy, modify, or learn from. Each subdirectory is a self-contained npm-publishable plugin demonstrating one extension surface.

| Example | What it shows |
|---|---|
| [`hello/`](./hello/) | Smallest possible plugin — registers one tool |
| [`timestamp/`](./timestamp/) | Self-contained tool with optional config and `isAvailable` gate |
| [`memory-logger/`](./memory-logger/) | A void hook that logs every memory write |
| [`personality/`](./personality/) | Shipping a personality as an npm package (not a directory drop-in) |
| [`safety-adapter/`](./safety-adapter/) | A `before_tool_call` modifying hook that blocks risky args |

For a top-down walkthrough of building your first tool, see [docs/tutorial/write-your-first-tool](https://ethosagent.ai/docs/tutorial/write-your-first-tool).

---

## What is a plugin?

A plugin is a TypeScript module that registers tools, hooks, injectors, and personalities into a running Ethos agent — without modifying the core codebase.

---

## Quick start

```bash
mkdir ~/.ethos/plugins/my-plugin
cd ~/.ethos/plugins/my-plugin
```

Create `index.ts`:

```typescript
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, ok } from '@ethosagent/plugin-sdk/tool-helpers';

export function activate(api: EthosPluginApi): void {
  api.registerTool(
    defineTool({
      name: 'my_tool',
      description: 'Does something useful',
      schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
      async execute({ input }) {
        return ok(`You said: ${input}`);
      },
    }),
  );
}

export function deactivate(): void {}
```

Restart `ethos` — your tool appears automatically.

---

## Examples

Four complete, tested examples in this directory:

| Example | Pattern | What it shows |
|---|---|---|
| [`example-hello/`](./hello/) | Multi-registration | Tool + void hook + personality in one plugin |
| [`example-timestamp/`](./timestamp/) | Tool only | Pure tool, no external deps, no API key |
| [`example-memory-logger/`](./memory-logger/) | Persistence hook | Writing to disk on `agent_done`, env-var config |
| [`example-safety-adapter/`](./safety-adapter/) | Modifying hooks | Blocking dangerous commands, prepending system prompt |
| [`example-personality/`](./personality/) | Personality | Custom identity, toolset, and injectors as a plugin |

Each example has `src/__tests__/unit.test.ts` and (where relevant) `integration.test.ts`.

---

## Plugin anatomy

```
my-plugin/
├── package.json        ← required: "ethos": { "type": "plugin" }
├── src/
│   ├── index.ts        ← exports activate() and deactivate()
│   └── __tests__/
│       ├── unit.test.ts
│       └── integration.test.ts
└── README.md
```

### `package.json` minimum

```json
{
  "name": "ethos-plugin-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "ethos": {
    "type": "plugin",
    "pluginApi": "1.0.0"
  }
}
```

### `index.ts` shape

```typescript
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';

export function activate(api: EthosPluginApi): void | Promise<void> {
  // register everything here
}

export function deactivate(): void | Promise<void> {
  // release external resources (DB connections, timers)
  // tools, hooks, injectors are removed automatically
}

export default { activate, deactivate } satisfies EthosPlugin;
```

---

## More

| Section | Page |
|---|---|
| What a plugin can register: tool, void hook, modifying hook, context injector, personality | [docs/registrations.md](docs/registrations.md) |
| Testing, deployment, CI checklist, security, reference | [docs/testing-and-deployment.md](docs/testing-and-deployment.md) |
