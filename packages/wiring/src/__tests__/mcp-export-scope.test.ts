// M-T2 — `resolveMcpExportScope`, the pure resolver that turns a personality's
// `mcp_export` declaration into the three `RunOptions` facts an exported turn
// runs under (plan/phases/trust-before-reach.md Part 3, M-D4/M-D5).
//
// Driven against a REAL `DefaultToolRegistry` rather than a stub reach: the
// whole point of `exclude` is the tools `toolsetNarrow` does not gate — an
// `mcp__*` tool, a plugin-registered tool, an `alwaysInclude` tool — and a
// hand-written Set would not reproduce how `toolNamesForPersonality` treats
// them. What the exclusion then DOES at dispatch is pinned in core
// (`packages/core/src/__tests__/tool-registry.test.ts`) and end-to-end for the
// same helper at `apps/ethos/src/commands/__tests__/serve-a2a-runner.test.ts`.

import { DefaultToolRegistry } from '@ethosagent/core';
import type { PersonalityConfig, PersonalityMcpExportConfig, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveMcpExportScope } from '../mcp-export';

function tool(name: string, extra?: Partial<Tool>): Tool {
  return {
    name,
    description: '',
    schema: {},
    capabilities: {},
    execute: async () => ({ ok: true, value: '' }),
    ...extra,
  } as Tool;
}

/**
 * The fixture registry: two built-ins the personality has, one built-in it does
 * NOT have, the two memory tools, an MCP tool, a plugin tool, and an
 * `alwaysInclude` tool. The last three are exactly the ones `toolsetNarrow`
 * lets past.
 */
function registry(): DefaultToolRegistry {
  const reg = new DefaultToolRegistry();
  reg.register(tool('read_file'));
  reg.register(tool('web_search'));
  reg.register(tool('terminal'));
  reg.register(tool('memory_read'));
  reg.register(tool('memory_write'));
  reg.register(tool('mcp__linear__get_issue'));
  reg.register(tool('brand_lookup'), { pluginId: 'brand' });
  reg.register(tool('clarify', { alwaysInclude: true }));
  return reg;
}

/** A personality whose reach is everything in the fixture registry. */
function personality(
  mcpExport?: PersonalityMcpExportConfig,
  overrides?: Partial<PersonalityConfig>,
): PersonalityConfig {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    toolset: ['read_file', 'web_search', 'memory_read', 'memory_write'],
    mcp_servers: ['linear'],
    plugins: ['brand'],
    ...(mcpExport ? { mcp_export: mcpExport } : {}),
    ...overrides,
  };
}

const EVERYTHING = [
  'brand_lookup',
  'clarify',
  'mcp__linear__get_issue',
  'memory_read',
  'memory_write',
  'read_file',
  'terminal',
  'web_search',
];

describe('resolveMcpExportScope — expose_tools × the personality toolset', () => {
  it("'all' is the personality's full reach, never the machine's", () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: 'all', expose_memory: 'full' }),
      registry(),
    );
    // `terminal` is registered but not in the toolset: outside the reach.
    expect(scope.allowed).toEqual([
      'brand_lookup',
      'mcp__linear__get_issue',
      'memory_read',
      'memory_write',
      'read_file',
      'web_search',
    ]);
    expect(scope.exclude).toEqual(['clarify', 'terminal']);
    expect(scope.dropped).toEqual([]);
  });

  it("'none' exposes nothing — a conversation-only specialist", () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: 'none' }),
      registry(),
    );
    expect(scope.allowed).toEqual([]);
    expect(scope.exclude).toEqual(EVERYTHING);
  });

  it('an ABSENT expose_tools is `none`, not `all` (M-D4 fail-closed)', () => {
    const scope = resolveMcpExportScope(personality({ enabled: true }), registry());
    expect(scope.allowed).toEqual([]);
    expect(scope.exclude).toEqual(EVERYTHING);
  });

  it('an explicit list is intersected with the reach', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file', 'web_search'] }),
      registry(),
    );
    expect(scope.allowed).toEqual(['read_file', 'web_search']);
  });

  it('an empty list is a real empty grant', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: [] }),
      registry(),
    );
    expect(scope.allowed).toEqual([]);
    expect(scope.exclude).toEqual(EVERYTHING);
  });

  it('naming a tool the personality does not have grants nothing — it is dropped', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file', 'terminal', 'ghost_tool'] }),
      registry(),
    );
    expect(scope.allowed).toEqual(['read_file']);
    // `terminal` is registered but not in the toolset; `ghost_tool` is not
    // registered at all. Both are outside the reach, so both are reportable.
    expect(scope.dropped).toEqual(['ghost_tool', 'terminal']);
    expect(scope.exclude).toContain('terminal');
  });

  it("'all'/'none' name nothing, so nothing can be dropped", () => {
    expect(
      resolveMcpExportScope(personality({ enabled: true, expose_tools: 'all' }), registry())
        .dropped,
    ).toEqual([]);
    expect(
      resolveMcpExportScope(personality({ enabled: true, expose_tools: 'none' }), registry())
        .dropped,
    ).toEqual([]);
  });
});

describe('resolveMcpExportScope — exclude reaches what narrow does not', () => {
  it('excludes the alwaysInclude tool that toolsetNarrow would let through', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file'] }),
      registry(),
    );
    // `clarify` is `alwaysInclude`, so `toDefinitions`/`executeParallel` skip
    // the name allowlist for it. Only the exclusion bounds it.
    expect(scope.allowed).not.toContain('clarify');
    expect(scope.exclude).toContain('clarify');
  });

  it('excludes an mcp__ tool the export did not name, even though the personality has it', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file'] }),
      registry(),
    );
    expect(scope.exclude).toContain('mcp__linear__get_issue');
  });

  it('excludes a plugin tool the export did not name', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file'] }),
      registry(),
    );
    expect(scope.exclude).toContain('brand_lookup');
  });

  it('an mcp__ or plugin tool the export DID name stays out of the exclusion', () => {
    const scope = resolveMcpExportScope(
      personality({
        enabled: true,
        expose_tools: ['mcp__linear__get_issue', 'brand_lookup'],
      }),
      registry(),
    );
    expect(scope.allowed).toEqual(['brand_lookup', 'mcp__linear__get_issue']);
    expect(scope.exclude).not.toContain('brand_lookup');
    expect(scope.exclude).not.toContain('mcp__linear__get_issue');
  });

  it('allowed and exclude partition everything registered', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file', 'brand_lookup'] }),
      registry(),
    );
    expect([...scope.allowed, ...scope.exclude].sort()).toEqual(EVERYTHING);
  });

  it('a tool registered AFTER the last resolve is excluded by the next one', () => {
    const reg = registry();
    const before = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file'] }),
      reg,
    );
    expect(before.exclude).not.toContain('mcp__late__tool');
    reg.register(tool('mcp__late__tool'));
    const after = resolveMcpExportScope(
      personality({ enabled: true, expose_tools: ['read_file'] }),
      reg,
    );
    expect(after.exclude).toContain('mcp__late__tool');
  });
});

describe('resolveMcpExportScope — expose_memory (M-D5)', () => {
  const withMemory = (expose_memory?: 'none' | 'scoped' | 'full') =>
    resolveMcpExportScope(
      personality({
        enabled: true,
        expose_tools: 'all',
        ...(expose_memory ? { expose_memory } : {}),
      }),
      registry(),
    );

  it("'none' strips both memory tools and is the default", () => {
    for (const scope of [withMemory('none'), withMemory()]) {
      expect(scope.memory).toBe('none');
      expect(scope.allowed).not.toContain('memory_read');
      expect(scope.allowed).not.toContain('memory_write');
      expect(scope.exclude).toContain('memory_read');
      expect(scope.exclude).toContain('memory_write');
    }
  });

  it("'scoped' keeps memory_read and strips memory_write", () => {
    const scope = withMemory('scoped');
    expect(scope.memory).toBe('scoped');
    expect(scope.allowed).toContain('memory_read');
    expect(scope.allowed).not.toContain('memory_write');
    expect(scope.exclude).toContain('memory_write');
  });

  it("'full' keeps both", () => {
    const scope = withMemory('full');
    expect(scope.allowed).toContain('memory_read');
    expect(scope.allowed).toContain('memory_write');
  });

  it('strips a memory tool the declaration named explicitly, too', () => {
    const scope = resolveMcpExportScope(
      personality({
        enabled: true,
        expose_tools: ['memory_read', 'memory_write'],
        expose_memory: 'scoped',
      }),
      registry(),
    );
    expect(scope.allowed).toEqual(['memory_read']);
    // Withheld by the memory mode, not missing from the reach: the memory row
    // says why, so it is not reported as a dropped tool.
    expect(scope.dropped).toEqual([]);
  });

  it('cannot grant a memory tool the personality does not have', () => {
    const scope = resolveMcpExportScope(
      personality(
        { enabled: true, expose_tools: 'all', expose_memory: 'full' },
        { toolset: ['read_file'] },
      ),
      registry(),
    );
    expect(scope.allowed).not.toContain('memory_write');
  });
});

describe('resolveMcpExportScope — fail-closed defaults (M-D4)', () => {
  it('a personality with no mcp_export exports nothing and excludes everything', () => {
    const scope = resolveMcpExportScope(personality(), registry());
    expect(scope.enabled).toBe(false);
    expect(scope.allowed).toEqual([]);
    expect(scope.dropped).toEqual([]);
    expect(scope.exclude).toEqual(EVERYTHING);
    expect(scope.memory).toBe('none');
    expect(scope.sessions).toBe(false);
    expect(scope.auth).toBe('localhost');
  });

  it('enabled: false collapses a permissive declaration to nothing', () => {
    const scope = resolveMcpExportScope(
      personality({
        enabled: false,
        expose_tools: 'all',
        expose_memory: 'full',
        expose_sessions: true,
        auth: 'bearer',
      }),
      registry(),
    );
    expect(scope.enabled).toBe(false);
    expect(scope.allowed).toEqual([]);
    expect(scope.memory).toBe('none');
    expect(scope.sessions).toBe(false);
    expect(scope.auth).toBe('localhost');
  });

  it('expose_sessions and auth default to false / localhost', () => {
    const scope = resolveMcpExportScope(personality({ enabled: true }), registry());
    expect(scope.enabled).toBe(true);
    expect(scope.sessions).toBe(false);
    expect(scope.auth).toBe('localhost');
  });

  it('carries an explicit expose_sessions / auth through', () => {
    const scope = resolveMcpExportScope(
      personality({ enabled: true, expose_sessions: true, auth: 'bearer' }),
      registry(),
    );
    expect(scope.sessions).toBe(true);
    expect(scope.auth).toBe('bearer');
  });

  it('is pure — resolving twice gives the same answer and registers nothing', () => {
    const reg = registry();
    const person = personality({ enabled: true, expose_tools: 'all', expose_memory: 'scoped' });
    expect(resolveMcpExportScope(person, reg)).toEqual(resolveMcpExportScope(person, reg));
    expect(reg.getAvailable()).toHaveLength(8);
  });
});
