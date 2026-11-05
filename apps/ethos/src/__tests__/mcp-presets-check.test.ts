import type { McpServerConfig } from '@ethosagent/tools-mcp';
import { MCP_PRESETS } from '@ethosagent/tools-mcp/presets';
import { describe, expect, it } from 'vitest';
import { findUnpinnedEntries, formatUnpinnedReport } from '../commands/mcp-presets-check';

const presets = Object.values(MCP_PRESETS);
const fs = MCP_PRESETS.filesystem;
const git = MCP_PRESETS.git;

const stdio = (name: string, command: string, args: string[]): McpServerConfig => ({
  name,
  transport: 'stdio',
  command,
  args,
});

describe('findUnpinnedEntries (ethos mcp presets --check)', () => {
  it('lists an unpinned filesystem entry and prints the pinned argv with its path kept', () => {
    const entry = stdio('fs', 'npx', ['-y', '@modelcontextprotocol/server-filesystem', '/data']);
    const found = findUnpinnedEntries([entry], presets);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'fs', preset: 'filesystem' });
    expect(found[0]?.pinnedArgs).toEqual([...(fs?.args ?? []), '/data']);
    expect(formatUnpinnedReport(found)).toContain('fs (preset: filesystem)');
  });

  it('lists a bare entry that already has --ignore-scripts', () => {
    const entry = stdio('fs', 'npx', [
      '-y',
      '--ignore-scripts',
      '@modelcontextprotocol/server-filesystem',
      '/data',
    ]);
    const found = findUnpinnedEntries([entry], presets);
    expect(found[0]?.pinnedArgs).toEqual([...(fs?.args ?? []), '/data']);
  });

  it('does not list a pinned entry', () => {
    const entry = stdio('fs', 'npx', [...(fs?.args ?? []), '/data']);
    expect(findUnpinnedEntries([entry], presets)).toEqual([]);
  });

  it('does not list an entry pinned to a different version the user chose', () => {
    const entry = stdio('fs', 'npx', ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/d']);
    expect(findUnpinnedEntries([entry], presets)).toEqual([]);
  });

  it('matches the uvx shape and keeps the --repository value', () => {
    const entry = stdio('g', 'uvx', ['mcp-server-git', '--repository', '/repo']);
    const found = findUnpinnedEntries([entry], presets);
    expect(found[0]?.pinnedArgs).toEqual([...(git?.args ?? []), '/repo']);
  });

  it('ignores remote entries and unrelated stdio servers', () => {
    const remote: McpServerConfig = { name: 'r', transport: 'streamable-http', url: 'https://x' };
    const other = stdio('o', 'npx', ['-y', 'left-pad']);
    expect(findUnpinnedEntries([remote, other], presets)).toEqual([]);
  });

  it('reports all-clear when nothing is unpinned', () => {
    expect(formatUnpinnedReport([])).toContain('pinned');
  });
});
