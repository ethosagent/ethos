import { describe, expect, it } from 'vitest';
import { formatDuration, formatToolFeedLine, previewArgs, truncatePreview } from '../lib/tool-feed';
import { projectEvent } from '../lib/verbosity';

describe('FW-11 tool feed formatter', () => {
  it('renders ┊ name · arg · duration', () => {
    const line = formatToolFeedLine({
      toolName: 'terminal',
      args: { cmd: 'ls -la' },
      durationMs: 312,
    });
    expect(line).toBe('┊ terminal · ls -la · 312ms');
  });
  it('renders without args when preview is empty', () => {
    const line = formatToolFeedLine({ toolName: 'idle_tool', args: {}, durationMs: 50 });
    expect(line).toBe('┊ idle_tool · 50ms');
  });
  it('formats duration ≥1000ms as Ns', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_200)).toBe('1.2s');
    expect(formatDuration(2_100)).toBe('2.1s');
  });
});
describe('FW-11 previewArgs', () => {
  it('uses the cmd/command field for terminal-shaped args', () => {
    expect(previewArgs({ cmd: 'ls -la' })).toBe('ls -la');
    expect(previewArgs({ command: 'pwd' })).toBe('pwd');
  });
  it('uses the query field for web_search-shaped args', () => {
    expect(previewArgs({ query: 'node 24 release' })).toBe('node 24 release');
  });
  it('uses the url field for web_extract-shaped args', () => {
    expect(previewArgs({ url: 'https://github.com/x/y' })).toBe('https://github.com/x/y');
  });
  it('uses the path field for read_file-shaped args', () => {
    expect(previewArgs({ path: '/etc/passwd' })).toBe('/etc/passwd');
  });
  it('falls back to first scalar field for unknown shapes', () => {
    expect(previewArgs({ widget: 'foo' })).toBe('foo');
  });
  it('handles plain strings', () => {
    expect(previewArgs('hello world')).toBe('hello world');
  });
  it('handles null/undefined', () => {
    expect(previewArgs(null)).toBe('');
    expect(previewArgs(undefined)).toBe('');
  });
});
describe('FW-11 truncatePreview', () => {
  it('does nothing when max is 0 (no limit)', () => {
    expect(truncatePreview('a'.repeat(500), 0)).toHaveLength(500);
  });
  it('does nothing when string fits', () => {
    expect(truncatePreview('short', 50)).toBe('short');
  });
  it('cuts to (max-1) chars and appends ellipsis', () => {
    const result = truncatePreview('a'.repeat(100), 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith('…')).toBe(true);
  });
});
describe('FW-11 tool_preview_length integration', () => {
  it('respects custom preview length', () => {
    const longCmd = 'rg --type=ts --hidden -n very-long-pattern-string-goes-here-too';
    const line = formatToolFeedLine({
      toolName: 'terminal',
      args: { cmd: longCmd },
      durationMs: 50,
      previewLength: 20,
    });
    // The preview itself is ≤20 chars.
    const arg = line.split(' · ')[1];
    expect(arg?.length).toBeLessThanOrEqual(20);
    expect(arg?.endsWith('…')).toBe(true);
  });
});
describe('FW-11 audience boundary at default verbosity', () => {
  // Cross-checks Phase 30.2: internal tool_progress events suppressed at
  // default verbosity. This relies on the verbosity helper but the assertion
  // lives here because it's a property of the tool-feed contract.
  it('suppresses internal tool_progress at default', () => {
    const ev = {
      type: 'tool_progress',
      toolName: 'terminal',
      message: 'internal-only',
      audience: 'internal',
    };
    expect(projectEvent(ev, 'default')).toEqual([]);
  });
  it('surfaces internal tool_progress at verbose', () => {
    const ev = {
      type: 'tool_progress',
      toolName: 'terminal',
      message: 'internal-only',
      audience: 'internal',
    };
    const lines = projectEvent(ev, 'verbose');
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain('internal-only');
  });
});
