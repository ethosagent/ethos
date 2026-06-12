// Gap 11 — `createToolReachGetter` is the live tool-reach closure wiring
// passes into the skills composition for `requires.tools` gating. It must
// (a) re-read the registry on every call so MCP/plugin tools registered
// after skills composition are visible, (b) respect the personality's
// toolset/plugin allowlists, and (c) exclude registered-but-unavailable
// tools (failed `isAvailable()`).

import { DefaultToolRegistry } from '@ethosagent/core';
import type { PersonalityConfig, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createToolReachGetter } from '../compose-tools';

function makeTool(name: string, opts?: { isAvailable?: () => boolean }): Tool {
  return {
    name,
    description: `test tool ${name}`,
    schema: { type: 'object', properties: {} },
    toolset: 'test',
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }),
    ...(opts?.isAvailable ? { isAvailable: opts.isAvailable } : {}),
  };
}

describe('createToolReachGetter', () => {
  const personality: PersonalityConfig = { id: 'p', name: 'P', toolset: ['bash', 'read_file'] };

  it('is lazy — tools registered after getter creation are visible', () => {
    const registry = new DefaultToolRegistry();
    const getReach = createToolReachGetter(registry);

    expect(getReach(personality)).toEqual(new Set());

    registry.register(makeTool('bash'));
    expect(getReach(personality)).toEqual(new Set(['bash']));

    registry.register(makeTool('read_file'));
    expect(getReach(personality)).toEqual(new Set(['bash', 'read_file']));
  });

  it('respects the personality toolset', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('bash'));
    registry.register(makeTool('web_search'));

    const reach = createToolReachGetter(registry)(personality);
    expect(reach.has('bash')).toBe(true);
    expect(reach.has('web_search')).toBe(false);
  });

  it('excludes registered-but-unavailable tools (isAvailable() false)', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('bash'));
    registry.register(makeTool('read_file', { isAvailable: () => false }));

    expect(createToolReachGetter(registry)(personality)).toEqual(new Set(['bash']));
  });

  it('includes plugin tools only for personalities that allow the plugin', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('chart_render'), { pluginId: 'charts' });

    const getReach = createToolReachGetter(registry);
    expect(getReach({ id: 'p', name: 'P', toolset: [], plugins: ['charts'] })).toEqual(
      new Set(['chart_render']),
    );
    expect(getReach({ id: 'q', name: 'Q', toolset: [] })).toEqual(new Set());
  });
});
