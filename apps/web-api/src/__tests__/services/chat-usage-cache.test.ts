// The context meter's ring numerator needs the real prompt size, so the `usage`
// SSE event carries the provider's cache counters. They are additive-optional:
// a cacheless call omits them. Parsed with the shared Zod schema, never cast.

import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { type ActivityEvent, type SseEvent, SseEventSchema } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../../features/chat/repository';
import { ChatService } from '../../features/chat/service';
import { makeStubAgentLoop } from '../test-helpers';

describe('ChatService — usage cache counters', () => {
  let store: SQLiteSessionStore;
  let buffer: SessionStreamBuffer<SseEvent>;
  let activityBuffer: SessionStreamBuffer<ActivityEvent>;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    buffer = new SessionStreamBuffer<SseEvent>();
    activityBuffer = new SessionStreamBuffer<ActivityEvent>();
  });

  afterEach(() => {
    buffer.destroy();
    activityBuffer.destroy();
    store.close();
  });

  async function usageEvent(usage: Record<string, number>) {
    const service = new ChatService({
      loop: makeStubAgentLoop({
        events: [
          {
            type: 'usage',
            inputTokens: 5,
            outputTokens: 1,
            estimatedCostUsd: 0,
            ...usage,
          },
          { type: 'done', text: '', turnCount: 1 },
        ],
      }),
      sessions: new ChatRepository(store),
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    const seen: SseEvent[] = [];
    service.subscribe(sessionId, 0, (b) => {
      seen.push(SseEventSchema.parse(b.event));
    })();
    return seen.find((e) => e.type === 'usage');
  }

  it('forwards cacheReadTokens and cacheCreationTokens', async () => {
    const e = await usageEvent({ cacheReadTokens: 80_000, cacheCreationTokens: 300 });
    expect(e?.type === 'usage' ? e.cacheReadTokens : null).toBe(80_000);
    expect(e?.type === 'usage' ? e.cacheCreationTokens : null).toBe(300);
  });

  it('omits the cache keys when the provider reported none', async () => {
    const e = await usageEvent({});
    expect(e).toBeDefined();
    expect(e && 'cacheReadTokens' in e).toBe(false);
    expect(e && 'cacheCreationTokens' in e).toBe(false);
  });
});
