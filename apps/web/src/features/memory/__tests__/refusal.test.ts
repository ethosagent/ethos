import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryFailure, retryMemoryQuery } from '../refusal';

// F04 — the Memory page renders a server refusal (NOT_CONFIGURED: the running
// backend has no file editor) from the ERROR, not from config.yaml's `memory`
// mode, which can already name a different backend while a restart is pending.

/** What the oRPC client throws for an `EthosError` (`apps/web-api/src/routes/rpc.ts`). */
function rpcError(code: string, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
}

const REASON =
  'The "vector" memory backend has no file editor: the agent reads its memory from that backend, not from MEMORY.md / USER.md files.';

describe('memoryFailure', () => {
  it('reads NOT_CONFIGURED as the backend refusal, with the server action', () => {
    expect(
      memoryFailure(
        rpcError('NOT_CONFIGURED', REASON, {
          action: 'Switch `memory:` to markdown or vault in Settings to edit memory here.',
        }),
      ),
    ).toEqual({
      kind: 'unsupported',
      message: REASON,
      action: 'Switch `memory:` to markdown or vault in Settings to edit memory here.',
    });
  });

  it('keeps the refusal when the error carries no action', () => {
    expect(memoryFailure(rpcError('NOT_CONFIGURED', REASON))).toEqual({
      kind: 'unsupported',
      message: REASON,
    });
  });

  it('treats every other failure as a load failure', () => {
    expect(memoryFailure(rpcError('INTERNAL', 'boom'))).toEqual({
      kind: 'failed',
      message: 'boom',
    });
    expect(memoryFailure(new TypeError('Failed to fetch'))).toEqual({
      kind: 'failed',
      message: 'Failed to fetch',
    });
    expect(memoryFailure('offline')).toEqual({ kind: 'failed', message: 'offline' });
  });
});

describe('retryMemoryQuery', () => {
  it('never re-sends a refusal', () => {
    expect(retryMemoryQuery(0, rpcError('NOT_CONFIGURED', REASON))).toBe(false);
  });

  it('retries anything else once, like the app default', () => {
    const err = rpcError('INTERNAL', 'boom');
    expect(retryMemoryQuery(0, err)).toBe(true);
    expect(retryMemoryQuery(1, err)).toBe(false);
  });
});

/** Source with comments blanked, so prose cannot pass an assertion. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('Memory page wiring', () => {
  // Read from source: the page needs a router, a query client and live RPCs to
  // render (same approach as pages/__tests__/chat-voice-clarify-refusal.test.ts).
  const page = stripComments(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'pages', 'Memory.tsx'), 'utf8'),
  );

  it('renders the list failure from the error code and does not retry a refusal', () => {
    expect(page).toContain('memoryFailure(listQuery.error)');
    expect(page).toContain('memoryFailure(historyQuery.error)');
    // Both queries: the Files tab and the Timeline.
    expect(page.match(/retry: retryMemoryQuery/g) ?? []).toHaveLength(2);
  });

  it('no longer decides the refusal from the config memory mode', () => {
    expect(page).not.toMatch(/memoryMode/);
    expect(page).not.toContain('listQuery.error as Error');
    expect(page).not.toContain('historyQuery.error as Error');
  });
});
