---
name: plugin-home
description: Scaffold a Home panel for an Ethos plugin — generates panel.tsx, wires build config, adds package.json exports
---

# Plugin Home Panel Scaffold

Generate a complete, working Home panel for an Ethos plugin.

## When to use

- Building a new plugin that needs a visual dashboard
- Adding a Home panel to an existing plugin
- Learning the plugin panel API by example

## Prerequisites

- Working plugin with `package.json` containing an `ethos` field
- At least one tool registered in the plugin

## What this skill generates

1. **`src/panel.tsx`** — Complete React Home panel with:
   - Auth status check via `credentialPreview()`
   - OAuth reconnect button via `requestOAuth()`
   - Tool execution via `executeTool()` with loading/error states
   - Theme-aware CSS using `var(--...)` custom properties
   - Error boundary wrapper

2. **`package.json` updates**:
   - `"hasHomePanel": true` in the `ethos` field
   - `"./panel": { "import": "./dist/panel.js" }` in exports
   - `"@ethosagent/ui-components": ">=0.x"` in peerDependencies
   - `"dev:panel"` script for watch mode

3. **`tsup.config.ts` updates**:
   - `panel` entry point added
   - React and ui-components marked as external

## Workflow

1. Read the plugin's `package.json` to extract:
   - Plugin ID, name, description
   - Credential schema from `ethos.credentials`
   - Tool names from the plugin's registered tools

2. Generate `src/panel.tsx` using the template, customized with:
   - Plugin-specific credential checks
   - Tabs for each major tool group
   - Summary metrics from the first tool

3. Update `package.json` with panel exports and peer deps

4. Update build config for panel entry

5. Run `npm run build` to verify the panel compiles

## Panel structure

The generated panel follows this layout:

```
┌─────────────────────────────────────────┐
│ [Plugin Name]           [Status badge]  │
│ [Detail line + action button if needed] │
├─────────────────────────────────────────┤
│ [Metric]   [Metric]   [Metric]         │
├─────────────────────────────────────────┤
│ [Tab A]  [Tab B]  [Tab C]              │
│ ──────────────────────────────────────  │
│ [Data content — loading skeleton        │
│  or rendered tool result]              │
└─────────────────────────────────────────┘
```

## Dev mode

After generating, iterate with:
```bash
npm run dev:panel   # watches src/panel.tsx, rebuilds on change
```

Desktop app re-imports on each drawer open. Web serves fresh on each request.
