// openclaw-9.5 item 1 — the web chat is a surface that can answer a missing
// plugin credential, so:
//   • `ChatService.send` opts the turn into the pre-turn credential check
//     (`credentialPrompt: true` on the loop's RunOptions), and
//   • the loop's `credential_required` event reaches the SSE stream as the
//     `credential_required` wire event, parsed with the shared Zod schema
//     (never cast) so a drift between AgentEvent and the contract fails here.

import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import type { AgentEvent } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { type ActivityEvent, type SseEvent, SseEventSchema } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../../features/chat/repository';
import { ChatService } from '../../features/chat/service';
import { makeStubAgentLoop } from '../test-helpers';

describe('ChatService — credential_required', () => {
  let store: SQLiteSessionStore;
  let sessions: ChatRepository;
  let buffer: SessionStreamBuffer<SseEvent>;
  let activityBuffer: SessionStreamBuffer<ActivityEvent>;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    sessions = new ChatRepository(store);
    buffer = new SessionStreamBuffer<SseEvent>();
    activityBuffer = new SessionStreamBuffer<ActivityEvent>();
  });

  afterEach(() => {
    buffer.destroy();
    activityBuffer.destroy();
    store.close();
  });

  const REFUSAL: AgentEvent[] = [
    {
      type: 'credential_required',
      pluginId: 'weather',
      credentialKey: 'WEATHER_API_KEY',
      kind: 'api_key',
      label: 'Weather API key',
      description: 'From your dashboard',
      sessionKey: 'web:abc',
      pendingUserMessage: 'weather in Pune?',
    },
    { type: 'done', text: '', turnCount: 0 },
  ];

  async function drain(service: ChatService, sessionId: string): Promise<SseEvent[]> {
    await new Promise((r) => setTimeout(r, 50));
    const seen: SseEvent[] = [];
    const unsubscribe = service.subscribe(sessionId, 0, (b) => {
      seen.push(SseEventSchema.parse(b.event));
    });
    unsubscribe();
    return seen;
  }

  it('opts every chat turn into the pre-turn credential check', async () => {
    const runOpts: unknown[] = [];
    const service = new ChatService({
      loop: makeStubAgentLoop({ onRun: (_input, opts) => runOpts.push(opts) }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
    await service.send({ clientId: 'tab-1', text: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    expect(runOpts).toHaveLength(1);
    expect(runOpts[0]).toMatchObject({ credentialPrompt: true });
  });

  it('forwards the bridge event onto the stream without sessionKey', async () => {
    const service = new ChatService({
      loop: makeStubAgentLoop({ events: REFUSAL }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'weather in Pune?' });

    const events = await drain(service, sessionId);
    const prompt = events.find((e) => e.type === 'credential_required');
    expect(prompt).toEqual({
      type: 'credential_required',
      pluginId: 'weather',
      credentialKey: 'WEATHER_API_KEY',
      kind: 'api_key',
      label: 'Weather API key',
      description: 'From your dashboard',
      pendingUserMessage: 'weather in Pune?',
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '' });
  });
});
