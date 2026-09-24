// reach-and-containment Part 1 (C1) — the pure tool-loading module.

import type { PersonalityConfig, Tool, ToolDefinitionLite } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultToolRegistry } from '../../tool-registry';
import {
  buildToolSearchDefinition,
  clampSearchLimit,
  composeDefinitions,
  MAX_LOADED_TOOLS,
  noteLoaded,
  readLoadedTools,
  resolvePinned,
  searchTools,
  TOOL_SEARCH_DEFINITION,
  TOOL_SEARCH_NAME,
  type ToolLoadingPlan,
} from '../tool-loading';

function tool(name: string, description = `${name} tool`, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description,
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => ({ ok: true, value: name }),
    ...extra,
  };
}

function registry(): DefaultToolRegistry {
  const r = new DefaultToolRegistry();
  r.register(tool('read_file'));
  r.register(tool('write_file'));
  r.register(tool('get_skill', 'load a skill', { alwaysInclude: true }));
  r.register(tool('mcp__github__list_issues', 'List GitHub issues'));
  r.register(tool('plug_thing', 'a plugin tool'), { pluginId: 'acme' });
  return r;
}

const def = (name: string, description = `${name} tool`): ToolDefinitionLite => ({
  name,
  description,
  parameters: { type: 'object' },
});

const persona = (opts: Partial<PersonalityConfig> = {}): PersonalityConfig => ({
  id: 'p',
  name: 'P',
  ...opts,
});

describe('resolvePinned', () => {
  it('intersects pinned_tools with the universe — a pin outside the allowlist is dropped', () => {
    const r = registry();
    const universe = r.toDefinitions(['read_file'], { allowedMcpServers: ['github'] });
    const pinned = resolvePinned(
      persona({ context_engine_options: { pinned_tools: 'read_file, write_file, not_a_tool' } }),
      universe,
      r,
    );
    // write_file is registered but outside the allowlist → not in the universe → never pinned.
    expect([...pinned].sort()).toEqual(['get_skill', 'read_file']);
    for (const name of pinned) expect(universe.map((d) => d.name)).toContain(name);
  });

  it('unset → built-ins + alwaysInclude are pinned; MCP and plugin tools are deferred', () => {
    const r = registry();
    const universe = r.toDefinitions(undefined, {
      allowedMcpServers: ['github'],
      allowedPlugins: ['acme'],
    });
    const pinned = resolvePinned(persona(), universe, r);
    expect([...pinned].sort()).toEqual(['get_skill', 'read_file', 'write_file']);
    expect(pinned.has('mcp__github__list_issues')).toBe(false);
    expect(pinned.has('plug_thing')).toBe(false);
  });
});

describe('composeDefinitions', () => {
  const universe = [def('a'), def('b'), def('c'), def('d')];

  it('pinned in registry order, then tool_search, then loaded in load order', () => {
    const plan: ToolLoadingPlan = { active: true, pinned: new Set(['c', 'a']), loaded: ['d', 'b'] };
    expect(composeDefinitions(universe, plan).map((d) => d.name)).toEqual([
      'a',
      'c',
      TOOL_SEARCH_NAME,
      'd',
      'b',
    ]);
  });

  it('drops a loaded name missing from the universe and keeps the rest in order', () => {
    const plan: ToolLoadingPlan = {
      active: true,
      pinned: new Set(['a']),
      loaded: ['d', 'gone', 'b', 'a'],
    };
    expect(composeDefinitions(universe, plan).map((d) => d.name)).toEqual([
      'a',
      TOOL_SEARCH_NAME,
      'd',
      'b',
    ]);
  });

  it('uses the supplied search definition', () => {
    const plan: ToolLoadingPlan = { active: true, pinned: new Set(), loaded: [] };
    const custom = { ...TOOL_SEARCH_DEFINITION, description: 'custom' };
    expect(composeDefinitions(universe, plan, custom)).toEqual([custom]);
  });
});

describe('searchTools', () => {
  const defs = [
    def('issue_tracker', 'Tracks things'),
    def('notes', 'Write issue notes'),
    def('github_issue', 'List github issues'),
    def('issue', 'x'),
    def('alpha', 'unrelated'),
  ];

  it('returns an exact-name match first', () => {
    expect(searchTools('issue', defs, 10)[0]?.name).toBe('issue');
  });

  it('scores a name hit above a description hit', () => {
    const ordered = [def('desc_only', 'mentions a widget'), def('widget_tool', 'nothing')];
    // Registry order puts desc_only first; the name hit (3) still outranks it (1).
    expect(searchTools('widget', ordered, 10).map((d) => d.name)).toEqual([
      'widget_tool',
      'desc_only',
    ]);
  });

  it('breaks score ties by registry order', () => {
    const tied = [def('zeta_x', 'y'), def('alpha_x', 'y')];
    expect(searchTools('x', tied, 10).map((d) => d.name)).toEqual(['zeta_x', 'alpha_x']);
  });

  it('ranks multi-token matches above single-token ones', () => {
    expect(searchTools('github issue', defs, 10)[0]?.name).toBe('github_issue');
  });

  it('clamps limit to 1..10 and defaults to 5', () => {
    const many = Array.from({ length: 20 }, (_, i) => def(`tool_${i}`, 'match'));
    expect(searchTools('match', many, 0)).toHaveLength(1);
    expect(searchTools('match', many, 99)).toHaveLength(10);
    expect(searchTools('match', many)).toHaveLength(5);
    expect(clampSearchLimit('3')).toBe(5);
    expect(clampSearchLimit(2.7)).toBe(2);
  });

  it('an empty query returns no hits', () => {
    expect(searchTools('', defs, 10)).toEqual([]);
    expect(searchTools('  --  ', defs, 10)).toEqual([]);
  });
});

describe('noteLoaded / readLoadedTools / buildToolSearchDefinition', () => {
  it('appends universe names only, skips pinned and duplicates, and stops at the cap', () => {
    const universe = new Set(['a', 'b', 'c']);
    const plan: ToolLoadingPlan = { active: true, pinned: new Set(['a']), loaded: [] };
    expect(noteLoaded(plan, universe, ['a', 'b', 'b', 'outside', 'c'])).toEqual(['b', 'c']);
    expect(plan.loaded).toEqual(['b', 'c']);

    const big = new Set(Array.from({ length: 40 }, (_, i) => `t${i}`));
    const full: ToolLoadingPlan = { active: true, pinned: new Set(), loaded: [] };
    noteLoaded(full, big, [...big]);
    expect(full.loaded).toHaveLength(MAX_LOADED_TOOLS);
  });

  it('reads loadedTools defensively from metadata', () => {
    expect(readLoadedTools(undefined)).toEqual([]);
    expect(readLoadedTools({ loadedTools: 'nope' })).toEqual([]);
    expect(readLoadedTools({ loadedTools: ['a', 3, 'b'] })).toEqual(['a', 'b']);
  });

  it('names the deferred count and the MCP server / plugin sources', () => {
    const r = registry();
    const universe = r.toDefinitions(undefined, {
      allowedMcpServers: ['github'],
      allowedPlugins: ['acme'],
    });
    const pinned = resolvePinned(persona(), universe, r);
    const search = buildToolSearchDefinition(universe, pinned, r);
    expect(search.name).toBe(TOOL_SEARCH_NAME);
    expect(search.description).toContain('2 more tools are available');
    expect(search.description).toContain('github, acme');
    // Static per universe: rebuilding gives byte-identical output.
    expect(JSON.stringify(buildToolSearchDefinition(universe, pinned, r))).toBe(
      JSON.stringify(search),
    );
  });
});
