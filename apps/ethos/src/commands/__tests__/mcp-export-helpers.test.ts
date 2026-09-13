// The two export helpers the CLI composition root owns but no other test
// exercises directly: the audit→observability mapping and the client entry.

import { claudeDesktop, type McpExportAuditEntry } from '@ethosagent/mcp-server';
import { describe, expect, it, vi } from 'vitest';
import {
  buildExportEntry,
  claudeDesktopExportEntry,
  createMcpExportAuditSink,
  DESKTOP_ENTRY_SECRET_PLACEHOLDER,
  exportEntryName,
  formatExportError,
  resolveExportWorkingDir,
} from '../mcp-export';

const entry = (over: Partial<McpExportAuditEntry> = {}): McpExportAuditEntry => ({
  kind: 'call',
  event: 'ask',
  personalityId: 'reviewer',
  clientId: 'key-sk-ethos-abcd1234',
  decision: 'accepted',
  ts: 1,
  ...over,
});

describe('createMcpExportAuditSink', () => {
  it('maps each kind to its mcp.export.* category, the way serve.ts maps a2a.*', () => {
    const seen: Array<Record<string, unknown>> = [];
    const sink = createMcpExportAuditSink((e) => seen.push(e));
    sink.record(entry({ kind: 'auth', event: 'initialize' }));
    sink.record(entry({ kind: 'discovery', event: 'tools/list' }));
    sink.record(entry({ kind: 'call', event: 'ask' }));
    expect(seen.map((e) => e.category)).toEqual([
      'mcp.export.auth',
      'mcp.export.discovery',
      'mcp.export.call',
    ]);
  });

  it('defaults a denial to warn severity and carries the reason as the cause', () => {
    const seen: Array<Record<string, unknown>> = [];
    createMcpExportAuditSink((e) => seen.push(e)).record(
      entry({ decision: 'denied', reason: 'export_disabled' }),
    );
    expect(seen[0]?.severity).toBe('warn');
    expect(seen[0]?.cause).toBe('export_disabled');
    expect(seen[0]?.details).toMatchObject({ decision: 'denied', personalityId: 'reviewer' });
  });

  it('is fail-open: a throwing observability handle never breaks the exchange', () => {
    const sink = createMcpExportAuditSink(() => {
      throw new Error('observability.db is gone');
    });
    expect(() => sink.record(entry())).not.toThrow();
  });

  it('records no body — only identifiers, a decision and a trace id', () => {
    const seen: Array<Record<string, unknown>> = [];
    createMcpExportAuditSink((e) => seen.push(e)).record(
      entry({ sessionKey: 'mcp:reviewer:stdio-claude:c1', traceId: 'tr-1' }),
    );
    expect(Object.keys(seen[0]?.details as object).sort()).toEqual([
      'clientId',
      'decision',
      'personalityId',
      'sessionKey',
      'traceId',
    ]);
  });
});

describe('buildExportEntry', () => {
  it('names the entry ethos-<id> and spawns serve --personality <id>', () => {
    const built = buildExportEntry({
      command: '/usr/bin/node',
      scriptPath: '/opt/ethos/index.js',
      personalityId: 'reviewer',
    });
    expect(built.name).toBe(exportEntryName('reviewer'));
    expect(built.args).toEqual([
      '/opt/ethos/index.js',
      'mcp',
      'serve',
      '--personality',
      'reviewer',
    ]);
    expect(built.env).toBeUndefined();
  });

  it('puts a bearer secret in env and never in argv, which ps exposes', () => {
    const built = buildExportEntry({
      command: 'node',
      scriptPath: 'ethos',
      personalityId: 'reviewer',
      secret: 'sk-ethos-supersecret',
    });
    expect(built.env).toEqual({ ETHOS_MCP_KEY: 'sk-ethos-supersecret' });
    expect(built.args.join(' ')).not.toContain('supersecret');
  });
});

describe('resolveExportWorkingDir', () => {
  it('pins to the personality directory under the data dir', () => {
    expect(resolveExportWorkingDir({ personalityId: 'reviewer', dataDir: '/home/u/.ethos' })).toBe(
      '/home/u/.ethos/personalities/reviewer',
    );
  });

  it('does not consult the process cwd', () => {
    const spy = vi.spyOn(process, 'cwd');
    resolveExportWorkingDir({ personalityId: 'reviewer', dataDir: '/home/u/.ethos' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('formatExportError', () => {
  it('is one line of JSON, so a spawning client can parse the refusal', () => {
    const line = formatExportError({
      ok: false,
      code: 'export_disabled',
      message: 'nope',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ level: 'error', code: 'export_disabled', msg: 'nope' });
  });
});

describe('claudeDesktopExportEntry', () => {
  const base = {
    command: '/usr/local/bin/node',
    scriptPath: '/opt/ethos/index.js',
    personalityId: 'specialist',
  };

  it('is byte-identical to what `ethos mcp install claude-desktop` writes into an empty config', () => {
    const out = claudeDesktopExportEntry({ ...base, bearer: true });
    const installed = claudeDesktop.serialise(
      claudeDesktop.injectEntry(
        {},
        buildExportEntry({ ...base, secret: DESKTOP_ENTRY_SECRET_PLACEHOLDER }),
      ),
    );
    expect(out.json).toBe(installed);
    expect(out.name).toBe('ethos-specialist');
    expect(out.secretPlaceholder).toBe(DESKTOP_ENTRY_SECRET_PLACEHOLDER);
    expect(JSON.parse(out.json).mcpServers['ethos-specialist']).toEqual({
      command: '/usr/local/bin/node',
      args: ['/opt/ethos/index.js', 'mcp', 'serve', '--personality', 'specialist'],
      env: { ETHOS_MCP_KEY: DESKTOP_ENTRY_SECRET_PLACEHOLDER },
    });
  });

  it('carries no env and no placeholder under localhost auth', () => {
    const out = claudeDesktopExportEntry({ ...base, bearer: false });
    expect(out.secretPlaceholder).toBeNull();
    expect(JSON.parse(out.json).mcpServers['ethos-specialist'].env).toBeUndefined();
  });
});
