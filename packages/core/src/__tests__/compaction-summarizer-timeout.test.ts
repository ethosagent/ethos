// R10 (openclaw-9.6-gaps) — a stalled summarizer must not hold the turn (and
// its lane) until the 20-minute streaming timeout. `maybeCompact` abandons the
// engine at `summarizerTimeoutMs` and fails open: the turn proceeds with the
// UN-compacted history, and nothing about the abandoned compaction is persisted.

import type { ContextEngineCompactInput, Message, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { maybeCompact } from '../agent-loop/compaction';
import { DefaultContextEngineRegistry } from '../context-engines/registry';

const personality: PersonalityConfig = { id: 'test', name: 'Test', context_engine: 'stalled' };
const meta = { sessionId: 's1', sessionKey: 'cli:s1', turnNumber: 1, lastCompactionTurn: 0 };

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

describe('compaction summarizer timeout', () => {
  it('abandons a summarizer that never resolves and keeps the full history', async () => {
    let summarizeCalled = false;
    const registry = new DefaultContextEngineRegistry();
    registry.register({
      name: 'stalled',
      async compact(opts: ContextEngineCompactInput) {
        summarizeCalled = true;
        await opts.llm?.summarize(opts.messages, 100);
        return { messages: [], notes: 'unreachable' };
      },
      shouldCompact: () => true,
    });
    let compressions = 0;
    const events: string[] = [];
    const history = [userMsg('a'.repeat(4000)), userMsg('b'.repeat(4000)), userMsg('question')];

    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registry,
        session: {
          recordCompression: async () => {
            compressions++;
          },
          updateUsage: async () => {},
          recordCompactionTurn: async () => {},
          // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        } as any,
        llmHandle: { summarize: () => new Promise<string>(() => {}) },
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        observability: { recordCompaction: (e: { code: string }) => events.push(e.code) } as any,
        force: true,
        summarizerTimeoutMs: 20,
      },
      history,
      '',
      personality,
      meta,
    );

    expect(summarizeCalled).toBe(true);
    expect(result.messages).toEqual(history);
    expect(result.notice).toBeUndefined();
    expect(compressions).toBe(0);
    expect(events).toContain('context_engine_timed_out');
  });
});
