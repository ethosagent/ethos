import { describe, expect, it } from 'vitest';
import { MCP_PRESETS, type McpPin, type McpPreset, PINS, presetSpec } from '../presets';

// Phase 0 of the unified catalog: no local preset may launch "whatever was
// published last". These tests are the enforcer for the claims in the header
// of presets.ts ("every preset names an EXACT version").

// An npm package spec ending in an exact semver. Same shape as `isExactVersion`
// in extensions/plugin-loader/src/lockfile.ts, copied rather than imported
// because tools-mcp has no dependency on plugin-loader.
const NPM_SPEC =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// uvx spec: PyPI name, then an exact release (calendar versions included).
const PYPI_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*@\d+(\.\d+)+([.-]?[0-9A-Za-z]+)*$/;

/** The package spec a preset's argv launches, or undefined when there is none. */
function launchedSpec(preset: Pick<McpPreset, 'command' | 'args'>): string | undefined {
  // npx: the first non-flag arg. uvx: the first arg.
  return preset.command === 'npx' ? preset.args.find((a) => !a.startsWith('-')) : preset.args[0];
}

/** The predicate the suite applies; exported to the fixture test below. */
function isPinnedLaunch(preset: Pick<McpPreset, 'command' | 'args'>): boolean {
  const spec = launchedSpec(preset);
  if (spec === undefined) return false;
  return (preset.command === 'npx' ? NPM_SPEC : PYPI_SPEC).test(spec);
}

const presets = Object.values(MCP_PRESETS);

describe('local MCP presets are pinned', () => {
  it('covers every preset in PINS and nothing else', () => {
    expect(Object.keys(PINS).sort()).toEqual(Object.keys(MCP_PRESETS).sort());
  });

  it("every npm preset's spec arg is name@exact-semver", () => {
    const npm = presets.filter((p) => p.command === 'npx');
    expect(npm.length).toBeGreaterThan(0);
    for (const p of npm) {
      expect(p.args[0], p.name).toBe('-y');
      expect(launchedSpec(p), p.name).toMatch(NPM_SPEC);
    }
  });

  it("every uvx preset's first arg is name@exact-version", () => {
    const py = presets.filter((p) => p.command === 'uvx');
    expect(py.length).toBeGreaterThan(0);
    for (const p of py) expect(p.args[0], p.name).toMatch(PYPI_SPEC);
  });

  it('npx presets skip install lifecycle scripts', () => {
    for (const p of presets.filter((x) => x.command === 'npx')) {
      expect(p.args, p.name).toContain('--ignore-scripts');
    }
  });

  it('the spec in args equals presetSpec(pin), so version cannot drift from pin', () => {
    for (const p of presets) {
      expect(launchedSpec(p), p.name).toBe(presetSpec(p.pin));
      expect(p.pin, p.name).toBe(PINS[p.name as keyof typeof PINS]);
      expect(p.pin.registry, p.name).toBe(p.command === 'npx' ? 'npm' : 'pypi');
    }
  });

  it('every pin carries an integrity of the right algorithm for its registry', () => {
    for (const p of presets) {
      const { registry, integrity } = p.pin;
      if (registry === 'npm') expect(integrity, p.name).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      else expect(integrity, p.name).toMatch(/^sha256-[0-9a-f]{64}$/);
    }
  });

  it('a preset whose args name a bare or ranged package fails the predicate', () => {
    const bare = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] };
    const latest = { command: 'npx', args: ['-y', 'left-pad@latest'] };
    const range = { command: 'npx', args: ['-y', 'left-pad@^1.3.0'] };
    const bareUv = { command: 'uvx', args: ['mcp-server-fetch'] };
    const rangeUv = { command: 'uvx', args: ['mcp-server-fetch@>=1'] };
    for (const fixture of [bare, latest, range, bareUv, rangeUv]) {
      expect(isPinnedLaunch(fixture), fixture.args.join(' ')).toBe(false);
    }
    expect(isPinnedLaunch({ command: 'npx', args: ['-y', 'left-pad@1.3.0'] })).toBe(true);
    expect(isPinnedLaunch({ command: 'uvx', args: ['mcp-server-fetch@2026.11.4'] })).toBe(true);
  });

  it('presetSpec joins package and version', () => {
    const pin: McpPin = { registry: 'npm', package: '@a/b', version: '1.2.3', integrity: 'x' };
    expect(presetSpec(pin)).toBe('@a/b@1.2.3');
  });
});
