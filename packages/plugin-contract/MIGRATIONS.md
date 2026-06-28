# Plugin Contract Migrations

## Deprecation policy

**Overlap window.** Ethos supports every plugin major in the inclusive range
`[MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR .. PLUGIN_CONTRACT_MAJOR]` simultaneously.
A bump to `PLUGIN_CONTRACT_MAJOR` does not by itself drop the prior major — a
major is only dropped when `MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR` is raised, which
happens only on a real breaking change. This lets already-published plugins keep
loading across an additive major bump.

The rule for plugin authors is simple: keep your `package.json` →
`ethos.pluginContractMajor` within the supported range, and apply the patch
described in the relevant section below when a breaking major lands. If your
plugin has no `pluginContractMajor` field, the loader allows it (backward compat
for older plugins); add the field before publishing to ClawHub.

---

## Major 4 (voice provider registration)

**Breaking:** adds `registerSttProvider` / `registerTtsProvider` to `EthosPluginApi` and
`sttProviders` / `ttsProviders` to `PluginRegistries`. Plugins built against major 3 continue
to load (overlap window), but any plugin calling the new methods must declare
`pluginContractMajor: 4`.

**Action:** bump `ethos.pluginContractMajor` to `4` in your plugin's `package.json`.

---

## Entry template

When the next major bump happens, copy this block, fill in the blanks, and
delete the placeholder text.

```markdown
## Major N → N+1 (YYYY-MM-DD)

### What changed

One paragraph: which field was renamed / removed / required.

### Why

One paragraph: the architectural reason. Future-you reading a bug report will
thank past-you for this.

### Migration

Step-by-step patch for plugin authors:

1. Update `package.json` → `ethos.pluginContractMajor` from `N` to `N+1`.
2. [Rename / remove / add] `<field>` in `activate(api)` / plugin manifest.
3. Run `pnpm test` against the updated contract to confirm compatibility.

### Affected symbol(s)

- `EthosPluginApi.<method>` — describe the change
- `@ethosagent/plugin-sdk:<export>` — describe the change
```

---

## Major 1 (current)

Initial contract. No migration required — major 1 is the baseline.

Fields in scope:

- `package.json.ethos.type` — must be `"plugin"`
- `package.json.ethos.pluginContractMajor` — optional integer; omit for pre-1.0
  plugins; set to `1` for all new plugins
- `package.json.ethos.id` — optional stable plugin identifier
- `activate(api: EthosPluginApi): void | Promise<void>` — entry point
- `deactivate?(): void | Promise<void>` — optional teardown
- `EthosPluginApi.registerTool(tool)`
- `EthosPluginApi.registerVoidHook(name, handler)`
- `EthosPluginApi.registerModifyingHook(name, handler)`
- `EthosPluginApi.registerInjector(injector)`
- `EthosPluginApi.registerPersonality(config)`
