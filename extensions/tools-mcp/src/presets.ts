// MCP server presets — well-known community servers with sensible defaults.
//
// Every invocation below was checked against the npm and PyPI registries and
// the upstream `modelcontextprotocol/servers` README, and each pinned argv was
// actually launched: the dates are beside `PINS`, all re-verified 2026-11-05
// (`google-calendar` was first verified 2026-09-04, the upstream four
// 2026-09-01). These are checked values, not guesses: if you change one,
// re-check it the same way.
//
// Every preset names an EXACT version (`PINS` below), so a launch never pulls
// whatever was published last. This file imports nothing, on purpose: it is
// exported as `@ethosagent/tools-mcp/presets` so the recipes and the CLI can
// load it without the rest of the package. `presets-pinned.test.ts` fails on a bare or
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
// npx presets run with `--ignore-scripts`, so a package's install lifecycle
// scripts do not run. Verified 2026-11-05 with a postinstall canary:
// `npx -y <tarball>` wrote the marker file, `npx -y --ignore-scripts
// <tarball>` did not (npm 11, node 24, user npmrc neutralised). Each preset
// below was also launched with the flag and kept serving.
//
// Bumping a pin (an ordinary PR):
//   1. Look up the new release: `npm view <pkg> version dist.integrity
//      license --json`, or `https://pypi.org/pypi/<pkg>/json` (`info.version`
//      and the sha256 of the `py3-none-any` wheel in `urls[]`).
//   2. Launch the new argv once with stdin held open and confirm it keeps
//      serving: `sleep 30 | timeout 10 npx -y --ignore-scripts <spec> [args]`
//      or `sleep 30 | timeout 10 uvx <spec> [args]` must exit 124.
//   3. Change `PINS.<id>` (version, integrity) and its verified-on date.
//   4. Run `pnpm test`. A pin whose `args` spec drifted from `PINS` fails.
// `ethos mcp presets --check` (apps/ethos/src/commands/mcp-presets-check.ts)
// tells a user which of their existing mcp.json entries predate a pin.
//
// A `sqlite` preset used to live here. It is gone on purpose: upstream moved
// the server to `modelcontextprotocol/servers-archived` (last release April
// 2025), it is Python-only, and the npm package the preset named
// (`@modelcontextprotocol/server-sqlite`) has never existed. Do not re-add it.

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
export function presetSpec(pin: McpPin): string {
  return `${pin.package}@${pin.version}`;
}

/** npx argv for a pin: auto-confirm, skip install scripts, then the spec. */
function npxArgs(pin: McpPin): string[] {
  return ['-y', '--ignore-scripts', presetSpec(pin)];
}

/** Pinned releases, each looked up and launched on the date beside it. */
export const PINS = {
  // verified 2026-11-05 · npm · licence "SEE LICENSE IN LICENSE"
  filesystem: {
    registry: 'npm',
    package: '@modelcontextprotocol/server-filesystem',
    version: '2.2.0',
    integrity:
      'sha512-mNLj/qhV+P4kj1qP8VzgQ2fjSmWcKDQ3Q+KpZEA+WahCDWHw5zJBRQUNSPZ6Ai2/ZGGUjzNzsFpz958a1+4T9A==',
  },
  // verified 2026-11-05 · PyPI wheel mcp_server_git-2026.11.4-py3-none-any.whl · MIT
  git: {
    registry: 'pypi',
    package: 'mcp-server-git',
    version: '2026.11.4',
    integrity: 'sha256-0cdaa8f446554d020f8ffa0e44ef45b89df4ed4deaeb961b4305d8a2852b4e0e',
  },
  // verified 2026-11-05 · PyPI wheel mcp_server_fetch-2026.11.4-py3-none-any.whl · MIT
  fetch: {
    registry: 'pypi',
    package: 'mcp-server-fetch',
    version: '2026.11.4',
    integrity: 'sha256-7c5891e3d3e3ea7d2d8c21acb9c64ccd30ff1f42beeea59f95715637b970307d',
  },
  // verified 2026-11-05 · npm · MIT · community server, not Google-official
  'google-calendar': {
    registry: 'npm',
    package: '@cocal/google-calendar-mcp',
    version: '2.8.1',
    integrity:
      'sha512-NQdZ/OdJJ8CQJtpg/GhMI2k8Mq0TaaAcagE9WOzI9xtR9SBB5DGeNc8D4kwNB5KqXMdjI5q+U6dx+bkFwaWzJg==',
  },
  // verified 2026-11-05 · npm · licence "SEE LICENSE IN LICENSE"
  memory: {
    registry: 'npm',
    package: '@modelcontextprotocol/server-memory',
    version: '2.1.0',
    integrity:
      'sha512-4rhufvmutolbl5O/RflMRenzhYnSh/wij3uMK8H2vuZ2xSGgrA6O2VXwsg/+tSb2UsU1hVDw1XwZ2lcCz8XR2g==',
  },
} as const satisfies Record<string, McpPin>;

export const MCP_PRESETS: Record<string, McpPreset> = {
  filesystem: {
    name: 'filesystem',
    description: 'Read/write local files under a required allowed path',
    command: 'npx',
    args: npxArgs(PINS.filesystem),
    // The server takes allowed directories as positional args, NOT from the
    // environment. Started with none it logs "Started without allowed
    // directories" and every tool call fails.
    envVars: [],
    argVars: ['ALLOWED_PATH'],
    category: 'Developer tools',
    pin: PINS.filesystem,
  },
  git: {
    name: 'git',
    description: 'Git repository operations (requires uvx)',
    command: 'uvx',
    args: [presetSpec(PINS.git), '--repository'],
    envVars: [],
    argVars: ['GIT_REPO_PATH'],
    category: 'Developer tools',
    pin: PINS.git,
  },
  fetch: {
    name: 'fetch',
    description: 'HTTP fetch operations (requires uvx)',
    command: 'uvx',
    args: [presetSpec(PINS.fetch)],
    envVars: [],
    argVars: [],
    category: 'Web',
    pin: PINS.fetch,
  },
  'google-calendar': {
    name: 'google-calendar',
    // Not one-click, and the description has to say so: the user creates an
    // OAuth client in their own Google Cloud project and points
    // GOOGLE_OAUTH_CREDENTIALS at the downloaded client JSON. The server then
    // runs a one-time browser consent on first use.
    description:
      'Read and manage Google Calendar events (set GOOGLE_OAUTH_CREDENTIALS to your Google Cloud OAuth client JSON)',
    command: 'npx',
    // Community server, not Google-official. Verified 2026-09-04 against the
    // npm registry (bin `google-calendar-mcp` -> build/index.js, so `npx -y`
    // resolves); re-pinned and relaunched 2026-11-05, see `PINS`.
    args: npxArgs(PINS['google-calendar']),
    envVars: ['GOOGLE_OAUTH_CREDENTIALS'],
    argVars: [],
    // 'Utilities', not the remote catalog's 'Productivity': the local presets
    // render in their own dropdown (AddMcpModal's stdio mode) with their own
    // three-label scheme, so borrowing a remote label would add a fourth stdio
    // category without ever putting the two lists side by side.
    category: 'Utilities',
    pin: PINS['google-calendar'],
  },
  memory: {
    name: 'memory',
    description: 'Key-value memory store',
    command: 'npx',
    args: npxArgs(PINS.memory),
    // Optional — defaults to a memory.json beside the installed package.
    envVars: ['MEMORY_FILE_PATH'],
    argVars: [],
    category: 'Utilities',
    pin: PINS.memory,
  },
};

/** Look up a preset by name. Returns undefined for unknown names. */
export function getPreset(name: string): McpPreset | undefined {
  return MCP_PRESETS[name];
}
