import { readFileTool } from '@ethosagent/tools-file';
import { createMemoryWriteTool } from '@ethosagent/tools-memory';
import { EthosError, type MemoryProvider, type Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { assertReadOnlyCapabilities, INITIATIVE_READ_TOOLS } from '../index';

function fake(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    schema: { type: 'object', properties: {} },
    capabilities: {},
    execute: async () => ({ ok: true, value: '' }),
    ...extra,
  };
}
const noMeta = (_name: string): { pluginId?: string } => ({});

function refusal(tools: Tool[], meta = noMeta): EthosError {
  try {
    assertReadOnlyCapabilities(tools, meta);
  } catch (e) {
    expect(e).toBeInstanceOf(EthosError);
    return e as EthosError;
  }
  throw new Error('expected refusal');
}

describe('L3 capability audit', () => {
  it('refuses a tool with fs_reach.write', () => {
    const e = refusal([fake('w', { capabilities: { fs_reach: { write: 'from-personality' } } })]);
    expect(e.code).toBe('INITIATIVE_TOOL_NOT_READ_ONLY');
    expect(e.message).toContain('w');
    expect(e.message).toContain('fs_reach.write');
  });

  it('refuses a tool with a process capability', () => {
    const e = refusal([fake('p', { capabilities: { process: { allowedBinaries: ['git'] } } })]);
    expect(e.code).toBe('INITIATIVE_TOOL_NOT_READ_ONLY');
    expect(e.message).toContain('process');
  });

  it('refuses a tool with a storage capability', () => {
    const e = refusal([fake('s', { capabilities: { storage: { scope: 'session', kind: 'kv' } } })]);
    expect(e.message).toContain('storage');
  });

  it('refuses an mcp__ tool', () => {
    const e = refusal([fake('mcp__srv__do')]);
    expect(e.message).toContain('mcp__srv__do');
    expect(e.message).toContain('MCP');
  });

  it('refuses a plugin-registered tool', () => {
    const e = refusal([fake('plug_tool')], (n) => (n === 'plug_tool' ? { pluginId: 'acme' } : {}));
    expect(e.message).toContain('plug_tool');
    expect(e.message).toContain('plugin');
  });

  it('refuses alwaysInclude for a tool that is not an engine tool', () => {
    const e = refusal([fake('dashboard_save', { alwaysInclude: true })]);
    expect(e.message).toContain('alwaysInclude');
  });

  it('allows alwaysInclude for an engine ledger tool', () => {
    expect(() =>
      assertReadOnlyCapabilities([fake('initiative_note', { alwaysInclude: true })], noMeta),
    ).not.toThrow();
  });

  it('read-only fake tools pass', () => {
    expect(() => assertReadOnlyCapabilities([fake('a'), fake('b')], noMeta)).not.toThrow();
  });

  it('real read_file passes', () => {
    expect(() => assertReadOnlyCapabilities([readFileTool], noMeta)).not.toThrow();
  });

  it('memory_write passes L3 (documented limitation) but fails L1', () => {
    const tool = createMemoryWriteTool({} as MemoryProvider);
    expect(() => assertReadOnlyCapabilities([tool], noMeta)).not.toThrow();
    expect((INITIATIVE_READ_TOOLS as readonly string[]).includes('memory_write')).toBe(false);
  });
});
