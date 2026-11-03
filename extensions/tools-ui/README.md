# @ethosagent/tools-ui

## Purpose

Tools that put UI in front of the user on the web and desktop surfaces: `render_image`, `render_html`, `render_file`, the card lane (`emit_card`, `render_ui`) and the dashboard tools (`dashboard_create`, `dashboard_add_panel` and others). It also holds a context injector that teaches the model how to compose cards. Rendering itself happens in the web app.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths). Main entry points.

| Export | Kind | One line |
|---|---|---|
| `buildUiTools` | function | The three `render_*` tools for an asset-dir resolver. |
| `buildCardTools` | function | The card lane (`emit_card`, `render_ui`), gated by the personality toolset. |
| `buildDashboardTools` | function | The dashboard tools over a `DashboardToolStore`. |
| `createRenderImageTool` | function | Builds `render_image`. |
| `createRenderFileTool` | function | Builds `render_file`. |
| `renderHtmlTool` | const | The `render_html` tool. |
| `createRenderUiTool` | function | Builds `render_ui`. |
| `emitCardTool` | const | The `emit_card` tool. |
| `dashboardSaveTool` | const | The `dashboard_save` tool. |
| `createDashboardCreateTool` | function | Builds `dashboard_create`. |
| `createDashboardAddPanelTool` | function | Builds `dashboard_add_panel`. |
| `DashboardToolStore` | interface | Store the dashboard tools write through. |
| `AssetDirResolver` | type | Maps a personality id to its asset folder. |
| `PersonalityDirResolver` | type | Maps a personality id to its directory. |
| `createUiGuidanceInjector` | function | Builds the card-composition prompt injector. |
| `isUiPlatform` | function | True for platforms that can draw cards. |
| `UI_PLATFORMS` | const | The set of such platforms (web, desktop). |

## Seam

Implements `Tool` and `ContextInjector` from `@ethosagent/types`; card envelopes are checked against `CardEnvelopeSchema`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-ui
```

Pinning tests in `src/__tests__/`: `src/__tests__/emit-card.test.ts` (every card kind round-trips through `CardEnvelopeSchema`, tool is toolset-gated, ack omits the payload), `src/__tests__/render-ui.test.ts` (inline and template modes, another personality's template is refused under the shared-turn deny), `src/__tests__/asset-dir.test.ts` (`files://` resolves against the supplied folder), `src/__tests__/dashboard-tools.test.ts` (store validation errors surface as `input_invalid`), `src/__tests__/ui-guidance-injector.test.ts` (byte-identical output across turns, own personality and card surfaces only).
