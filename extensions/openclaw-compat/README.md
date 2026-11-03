# @ethosagent/openclaw-compat

## Purpose

Lets an OpenClaw plugin load into Ethos. `OpenClawPluginApiShim` is the `api` object a plugin's `register(api)` receives; channel plugins become `PlatformAdapter`s and memory capabilities become `MemoryProvider`s. Plugin discovery and loading are left to the plugin loader that calls it.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`). Main entry points; the remaining exports are OpenClaw-shaped types.

| Export | Kind | One line |
|---|---|---|
| `createOpenClawApiShim` | function | Builds the shim over an `EthosPluginApi`. |
| `OpenClawPluginApiShim` | class | OpenClaw-shaped `api` that translates registrations to Ethos equivalents. |
| `OpenClawCompatCallbacks` | interface | `onPlatformAdapter` callback and an optional logger. |
| `extractOpenClawRegister` | function | Finds the `register` function on a loaded module. |
| `isOpenClawPackageJson` | function | Detects an OpenClaw plugin by its `package.json`. |
| `translateChannelPlugin` | function | `ChannelPlugin` to `PlatformAdapter`. |
| `unwrapChannelRegistration` | function | Accepts a bare plugin or a `{ plugin }` wrapper. |
| `translateMemoryCapability` | function | `MemoryPluginCapability` to `MemoryProvider`. |
| `translateMemoryRuntime` | function | `MemoryPluginRuntime` to a search-driven `MemoryProvider`. |
| `translatePromptSectionBuilder` | function | Prompt section builder to a `ContextInjector`. |
| `translateCorpusSupplement` | function | Corpus supplement to a `ContextInjector`. |
| `translateBeforePromptBuildHook` | function | `before_prompt_build` hook to a `ContextInjector`. |
| `ChannelPlugin` | type | OpenClaw channel plugin shape. |
| `MemoryPluginCapability` | type | OpenClaw memory capability shape. |

## Seam

Produces `PlatformAdapter` and `MemoryProvider` from `@ethosagent/types` (return types of `translateChannelPlugin` in `src/channel-translator.ts` and `translateMemoryCapability` in `src/memory-translator.ts`) and registers through `@ethosagent/plugin-sdk`. Archcheck layer: `extensions`.

Pinned by `src/__tests__/channel-translator.test.ts` (capability flags map from the plugin; `send` returns an error result when there is no outbound adapter or it throws) and `src/__tests__/memory-translator.test.ts` (no prompt builder or runtime gives a null prefetch; a runtime provider's prefetch is always null).

Limitation: the shim's handling of unsupported registration methods (warn and ignore, per the comment on `OpenClawPluginApiShim` in `src/api.ts`) has no test, and `src/api.ts` has no test file.

## Testing

```
pnpm vitest run extensions/openclaw-compat
```

Pinning tests in `src/__tests__/`: `src/__tests__/channel-translator.test.ts` (static fields, `start`, `stop`, `send`, `onMessage`, `health`, `unwrapChannelRegistration`), `src/__tests__/memory-translator.test.ts` (capability and runtime translation).
