// Phase 30.6 — plugin contract version gate.
//
// Plugins declare the contract major they were built against in their
// package.json under `ethos.pluginContractMajor` (an integer). The plugin
// loader checks this against `PLUGIN_CONTRACT_MAJOR` here at load time and
// rejects incompatible plugins with a clear message linking to MIGRATIONS.md.
//
// Bump this number on any breaking change to the plugin contract:
//   - field rename
//   - field removal
//   - required-field addition
// Non-breaking additions (new optional field, additive method on PluginApi)
// stay on the same major.
//
// Deprecation policy is an overlap window: Ethos accepts plugins declaring any
// major in the inclusive range `[MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR ..
// PLUGIN_CONTRACT_MAJOR]`. When a bump introduces a REAL break, raise
// `MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR` to drop the now-incompatible majors.
// See `MIGRATIONS.md` header.

export const PLUGIN_CONTRACT_MAJOR = 4;

export const MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR = 2;

export interface ContractCompatResult {
  ok: boolean;
  /**
   * One-line user-facing reason. Includes the plugin name (when available),
   * declared major, current major, and a link to MIGRATIONS.md.
   */
  reason?: string;
}

/**
 * True when `declared` is undefined (older plugin without a declaration —
 * loader allows it for backward compat) OR when `declared` falls within the
 * inclusive supported range `[MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR .. current]`.
 *
 * Fails when: `declared` is a non-integer or negative; `declared > current`
 * (built for a future contract); or `declared < MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR`
 * (too old, support dropped).
 */
export function checkPluginContractMajor(
  declared: number | undefined,
  current: number = PLUGIN_CONTRACT_MAJOR,
  pluginName = 'plugin',
): ContractCompatResult {
  if (declared === undefined) {
    return { ok: true };
  }
  if (!Number.isInteger(declared) || declared < 0) {
    return {
      ok: false,
      reason: `${pluginName} declared an invalid pluginContractMajor (${String(declared)}); expected a non-negative integer. Current contract major is ${current}. See https://github.com/ethosdev/ethos/blob/main/packages/plugin-contract/MIGRATIONS.md`,
    };
  }
  if (declared > current) {
    return {
      ok: false,
      reason: `${pluginName} declares pluginContractMajor=${declared}, but Ethos's current plugin contract is major=${current}. Update the plugin per https://github.com/ethosdev/ethos/blob/main/packages/plugin-contract/MIGRATIONS.md`,
    };
  }
  if (declared < MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR) {
    return {
      ok: false,
      reason: `${pluginName} declares pluginContractMajor=${declared}, which is below the minimum supported major (${MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR}); Ethos's current plugin contract is major=${current}. Update the plugin per https://github.com/ethosdev/ethos/blob/main/packages/plugin-contract/MIGRATIONS.md`,
    };
  }
  return { ok: true };
}
