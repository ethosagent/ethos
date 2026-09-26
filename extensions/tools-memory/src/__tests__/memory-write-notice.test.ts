/**
 * W4 (ux-feedback-and-config-clarity) — `memory_write` emits one user-audience
 * progress notice per successful write (`remembered · "…" → MEMORY.md|USER.md`,
 * `forgot · …` for removes), truncated to 60 chars of content, and nothing on
 * a failed write.
 */

import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryProvider, ToolContext, ToolProgressEvent } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryWriteTool } from '../index';

function makeCtx(emit: (event: ToolProgressEvent) => void): ToolContext {
  return {
    sessionId: 'test-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit,
    resultBudgetChars: 80_000,
    personalityId: 'helper',
    memoryScopeId: 'personality:helper',
    userScopeId: 'user:mitesh',
  };
}

function makeTool() {
  const storage = new InMemoryStorage();
  const memory = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });
  return createMemoryWriteTool(memory);
}

describe('memory_write user notice', () => {
  it("emits a user-audience 'remembered' notice on add", async () => {
    const emit = vi.fn();
    const result = await makeTool().execute(
      { store: 'user', action: 'add', content: 'prefers pnpm over npm' },
      makeCtx(emit),
    );
    expect(result.ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'progress',
      toolName: 'memory_write',
      audience: 'user',
      message: 'remembered · "prefers pnpm over npm" → USER.md',
    });
  });

  it('quotes at most 60 chars of content, with an ellipsis', async () => {
    const emit = vi.fn();
    const long = 'x'.repeat(100);
    await makeTool().execute({ store: 'memory', action: 'add', content: long }, makeCtx(emit));
    const event = emit.mock.calls[0]?.[0] as ToolProgressEvent;
    expect(event.message).toBe(`remembered · "${'x'.repeat(60)}…" → MEMORY.md`);
  });

  it("phrases a remove as 'forgot', quoting the match", async () => {
    const emit = vi.fn();
    const tool = makeTool();
    await tool.execute(
      { store: 'memory', action: 'add', content: 'old fact' },
      makeCtx(() => {}),
    );
    emit.mockClear();
    const result = await tool.execute(
      { store: 'memory', action: 'remove', content: 'old fact', substring_match: 'old fact' },
      makeCtx(emit),
    );
    expect(result.ok).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      type: 'progress',
      toolName: 'memory_write',
      audience: 'user',
      message: 'forgot · "old fact" → MEMORY.md',
    });
  });

  it('emits nothing when the write fails', async () => {
    const emit = vi.fn();
    const failing: MemoryProvider = {
      prefetch: async () => null,
      read: async () => null,
      search: async () => [],
      sync: async () => {
        throw new Error('disk full');
      },
      list: async () => [],
    };
    await expect(
      createMemoryWriteTool(failing).execute(
        { store: 'memory', action: 'add', content: 'never claimed' },
        makeCtx(emit),
      ),
    ).rejects.toThrow('disk full');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits nothing on invalid input', async () => {
    const emit = vi.fn();
    const result = await makeTool().execute(
      { store: 'memory', action: 'bogus', content: 'x' },
      makeCtx(emit),
    );
    expect(result.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
