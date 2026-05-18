/**
 * Boundary redaction test: verifies that tools-memory redacts credentials
 * at the tool output boundary, not inside the storage provider.
 */

import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createMemoryReadTool } from '../index';

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
    await storage.mkdir(dir);
    const key = `sk-ant-${'A'.repeat(93)}`;
    await storage.write(`${dir}/MEMORY.md`, `Project key: ${key}\n`);

    const provider = new MarkdownFileMemoryProvider({ dir, storage });
    const tool = createMemoryReadTool(provider);
    const ctx = makeCtx({ memoryScopeId: 'global' });

    const result = await tool.execute({ store: 'memory' }, ctx);
    expect(result.ok).toBe(true);
    expect('value' in result && result.value).toContain('[REDACTED:anthropic-key]');
    expect('value' in result && result.value).not.toContain(key);
  });
});
