/**
 * Boundary redaction test: verifies that tools-memory redacts credentials
 * at the tool output boundary, not inside the storage provider.
 */

import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { SessionStore, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createMemoryReadTool, createSessionSearchTool } from '../index';

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

describe('redaction boundary — tools-memory', () => {
  it('memory_read redacts credentials at the tool output boundary', async () => {
    const storage = new InMemoryStorage();
    const dir = '/ethos/test-redact';
    const scopeDir = `${dir}/personalities/test`;
    await storage.mkdir(scopeDir);
    const key = `sk-ant-${'A'.repeat(93)}`;
    await storage.write(`${scopeDir}/MEMORY.md`, `Project key: ${key}\n`);

    const provider = new MarkdownFileMemoryProvider({ dir, storage });
    const tool = createMemoryReadTool(provider);
    const ctx = makeCtx({ memoryScopeId: 'personality:test' });

    const result = await tool.execute({ store: 'memory' }, ctx);
    expect(result.ok).toBe(true);
    expect('value' in result && result.value).toContain('[REDACTED:anthropic-key]');
    expect('value' in result && result.value).not.toContain(key);
  });

  it('session_search redacts secrets in search results', async () => {
    const key = `sk-ant-${'X'.repeat(93)}`;
    const mockSession = {
      search: async () => [
        {
          sessionId: 'test-session',
          messageId: 'msg-1',
          snippet: `Found key: ${key} in logs`,
          score: 1,
          timestamp: new Date(),
        },
      ],
    } as unknown as SessionStore;

    const tool = createSessionSearchTool(mockSession);
    const ctx = makeCtx();
    const result = await tool.execute({ query: 'key' }, ctx);
    expect(result.ok).toBe(true);
    expect('value' in result && result.value).toContain('[REDACTED:anthropic-key]');
    expect('value' in result && result.value).not.toContain(key);
  });
});
