// MCP server presets — a DERIVED VIEW over the catalog index.
//
// The entries live in packages/catalog/src/entries/mcp/<id>.ts, and so do the
// per-preset verification notes (what was launched and when, licence,
// handshake results). This file builds `MCP_PRESETS` from the catalog entries
// whose pin is npm or PyPI; the shape and names are unchanged, so nothing that
// reads a preset needed to move. `presets-golden.test.ts` pins the derived
// tables equal to the frozen Phase 0 output.
//
// Every preset names an EXACT version (`PINS` below), so a launch never pulls
// whatever was published last. This file imports only `@ethosagent/catalog`
// (pure data, no runtime dependencies) on purpose: it is exported as
// `@ethosagent/tools-mcp/presets` so the recipes and the CLI can load it
// without the rest of the package. `presets-pinned.test.ts` fails on a bare or
// ranged package, on an `args` spec that drifted from its pin, and on an
// integrity of the wrong algorithm for its registry.
//
// uvx takes the same `name@version` form (uv 0.7.11 resolves `pkg@1.2.3` to the
// exact constraint `==1.2.3`, checked 2026-11-05).
//
// What a pin does and does not buy: it fixes the top-level package's bytes.
// It does NOT fix transitive dependencies (their ranges still resolve at
// first launch), and neither launcher takes a digest, so `integrity` is a
// recorded value for review and for a later admission check — not enforced
// at launch. Python presets have no code scan anywhere.
//
// npx presets run with `--ignore-scripts` (`launcherArgs` in
// packages/catalog/src/pin.ts), so a package's install lifecycle scripts do
// not run. Verified 2026-11-05 with a postinstall canary: `npx -y <tarball>`
// wrote the marker file, `npx -y --ignore-scripts <tarball>` did not (npm 11,
// node 24, user npmrc neutralised). Each preset was also launched with the
// flag and kept serving.
//
// Bumping a pin (an ordinary PR):
//   1. Look up the new release: `npm view <pkg> version dist.integrity
//      license --json`, or `https://pypi.org/pypi/<pkg>/json` (`info.version`
//      and the sha256 of the `py3-none-any` wheel in `urls[]`).
//   2. Launch the new argv once with stdin held open and confirm it keeps
//      serving: `sleep 30 | timeout 10 npx -y --ignore-scripts <spec> [args]`
//      or `sleep 30 | timeout 10 uvx <spec> [args]` must exit 124.
//   3. Change the `pin` and the verification note in the entry file under
//      packages/catalog/src/entries/mcp/ (version, integrity, date).
//   4. Run `pnpm test`. A pin whose `args` spec drifted from `PINS` fails.
// `ethos mcp presets --check` (apps/ethos/src/commands/mcp-presets-check.ts)
// tells a user which of their existing mcp.json entries predate a pin.
//
// A `sqlite` preset used to live here. It is gone on purpose: upstream moved
// the server to `modelcontextprotocol/servers-archived` (last release April
// 2025), it is Python-only, and the npm package the preset named
// (`@modelcontextprotocol/server-sqlite`) has never existed. Do not re-add it.

import { catalogEntriesOfKind, launcherArgs, type PackagePin, pinSpec } from '@ethosagent/catalog';

export interface McpPreset {
  name: string;
  description: string;
  command: string;
  args: string[];
  envVars: string[]; // env vars this preset expects
  /**
   * Values the user supplies that are appended to `args`, in order.
   *
   * The final argv is `command` + `args` + one value per entry here, in
   * declaration order. Servers that take their configuration on the command
   * line (rather than from the environment) need this: `server-filesystem`
   * reads its allowed directories as positional arguments, and `mcp-server-git`
   * takes `--repository <path>` — the flag lives in `args`, the value here.
   */
  argVars: string[];
  /** Grouping label for the catalog UI, e.g. "Developer tools". */
  category: string;
  /** The exact release `args` launches. `args` carries `presetSpec(pin)`. */
  pin: McpPin;
}

/**
 * The exact release a local preset launches. `integrity` is the npm
 * `dist.integrity` (`sha512-<base64>`) or `sha256-<hex>` of the PyPI
 * `py3-none-any` wheel; recorded, not enforced at launch (see the header).
 */
export interface McpPin {
  registry: 'npm' | 'pypi';
  package: string;
  version: string;
  integrity: string;
}

/** The launcher spec for a pin, `name@version`, which npx and uvx both accept. */
export const presetSpec: (pin: McpPin) => string = pinSpec;

function pinOf(pin: PackagePin): McpPin {
  return {
    registry: pin.type,
    package: pin.package,
    version: pin.version,
    integrity: pin.integrity,
  };
}

function derivePresets(): Record<string, McpPreset> {
  const presets: Record<string, McpPreset> = {};
  for (const entry of catalogEntriesOfKind('mcp')) {
    const { pin, mcp } = entry;
    if ((pin.type !== 'npm' && pin.type !== 'pypi') || !mcp) continue;
    presets[entry.id] = {
      name: entry.id,
      description: entry.description,
      command: pin.type === 'npm' ? 'npx' : 'uvx',
      args: [...launcherArgs(pin), ...mcp.argsAfterSpec],
      envVars: [...mcp.envVars],
      argVars: [...mcp.argVars],
      category: entry.category,
      pin: pinOf(pin),
    };
  }
  return presets;
}

export const MCP_PRESETS: Record<string, McpPreset> = derivePresets();

/** Pinned releases by preset id, read from the catalog. Each equals `MCP_PRESETS[id].pin`. */
export const PINS: Record<string, McpPin> = Object.fromEntries(
  Object.values(MCP_PRESETS).map((p) => [p.name, p.pin]),
);

/** Look up a preset by name. Returns undefined for unknown names. */
export function getPreset(name: string): McpPreset | undefined {
  return MCP_PRESETS[name];
}
