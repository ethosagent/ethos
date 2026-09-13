/**
 * A ToolContext built outside an AgentLoop turn carries no `memoryScopeId`
 * (realtime voice host, web tool-test probe, plugin panel). The memory tools
 * used to fall back to the scope id `global`, which the markdown backend
 * rejects by throwing (`resolveScopeDir`). They now return a `not_available`
 * tool error naming why, and never reach the backend.
 */

import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createMemoryReadTool, createMemoryWriteTool } from '../index';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

function makeProvider(storage = new InMemoryStorage()) {
  return { storage, memory: new MarkdownFileMemoryProvider({ dir: '/ethos', storage }) };
}

describe('memory tools — no memory scope', () => {
  const noScopeCases: Array<[string, 'read' | 'write', Record<string, unknown>]> = [
    ['memory_read store=both', 'read', {}],
    ['memory_read store=memory', 'read', { store: 'memory' }],
    ['memory_read store=user', 'read', { store: 'user' }],
    ['memory_read by key', 'read', { key: 'notes.md' }],
    ['memory_write store=memory', 'write', { store: 'memory', action: 'add', content: 'x' }],
    ['memory_write store=user', 'write', { store: 'user', action: 'add', content: 'x' }],
  ];

  for (const [name, kind, args] of noScopeCases) {
    it(`${name} returns not_available instead of throwing`, async () => {
      const { memory, storage } = makeProvider();
      const tool = kind === 'read' ? createMemoryReadTool(memory) : createMemoryWriteTool(memory);

      const result = await tool.execute(args, makeCtx());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('No memory scope');
      // Nothing was written under an invented scope.
      expect(await storage.exists('/ethos/MEMORY.md')).toBe(false);
      expect(await storage.exists('/ethos/USER.md')).toBe(false);
    });
  }

  it('a personality-scoped write then read is unchanged', async () => {
    const { memory, storage } = makeProvider();
    const ctx = makeCtx({ personalityId: 'helper', memoryScopeId: 'personality:helper' });

    const write = await createMemoryWriteTool(memory).execute(
      { store: 'memory', action: 'add', content: 'Prefers short answers.' },
      ctx,
    );
    expect(write).toEqual({ ok: true, value: 'Appended to MEMORY.md' });
    expect(await storage.read('/ethos/personalities/helper/MEMORY.md')).toContain(
      'Prefers short answers.',
    );

    const read = await createMemoryReadTool(memory).execute({ store: 'memory' }, ctx);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toContain('Prefers short answers.');
  });

  it('store=user with a user scope but no personality scope still reads the user scope', async () => {
    const { memory, storage } = makeProvider();
    await storage.mkdir('/ethos/users/u1');
    await storage.write('/ethos/users/u1/USER.md', 'Lives in a timezone.\n');

    const result = await createMemoryReadTool(memory).execute(
      { store: 'user' },
      makeCtx({ userScopeId: 'user:u1' }),
    );
    expect(result).toEqual({ ok: true, value: 'Lives in a timezone.' });
  });
});
