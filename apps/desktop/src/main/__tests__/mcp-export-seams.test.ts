import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron-store before importing serve (store.ts depends on it)
vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string) {
      return undefined;
    }
  },
}));

// Mock keychain (depends on Electron safeStorage)
vi.mock('../keychain', () => ({
  getKeychainValue: vi.fn().mockResolvedValue(null),
}));

const { desktopReadObservabilityEvents } = await import('../serve');

// M-T9 — the MCP export section's Recent denials. `ethos serve` passes
// `readObservabilityEvents`; the desktop host passed nothing, so the section
// showed no denials there. `startServer` cannot run without a live Electron
// main process, so the hand-off into `createWebApi` is asserted against source,
// the way `serve.test.ts` covers the other seams.
describe('desktopReadObservabilityEvents', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'desktop-obs-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the mcp.export events `ethos mcp serve` recorded into observability.db', () => {
    const writer = new SQLiteObservabilityStore(join(dataDir, 'observability.db'));
    writer.insertEvent({
      eventId: 'evt-1',
      ts: 1_700_000_000_000,
      category: 'mcp.export.tool_call',
      severity: 'warn',
      code: 'tool_call',
      cause: 'not_exported',
      details: { decision: 'denied', personalityId: 'researcher', clientId: 'c1' },
    });
    writer.close();

    const events = desktopReadObservabilityEvents(dataDir)({
      category: 'mcp.export.tool_call',
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'evt-1',
      cause: 'not_exported',
      details: { decision: 'denied', personalityId: 'researcher', clientId: 'c1' },
    });
  });

  it('reads no events, and creates no database, when observability.db does not exist', () => {
    const read = desktopReadObservabilityEvents(dataDir);
    expect(read({ category: 'mcp.export.tool_call', limit: 10 })).toEqual([]);
    expect(existsSync(join(dataDir, 'observability.db'))).toBe(false);
  });

  it('is handed to createWebApi over the desktop data dir', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'serve.ts'), 'utf8');
    expect(src).toContain('readObservabilityEvents: desktopReadObservabilityEvents(dataDir),');
  });
});
