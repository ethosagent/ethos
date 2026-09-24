import type { Session, SessionStore, StoredMessage } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { forkSession } from '../session-fork';

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

async function seedSource(store: SessionStore): Promise<Session> {
  const source = await store.createSession({
    key: 'cli:proj',
    platform: 'cli',
    model: 'claude-opus-4-7',
    provider: 'anthropic',
    personalityId: 'researcher',
    workingDir: '/work/proj',
    title: 'Planning',
    metadata: { pinnedTools: ['read_file'] },
    usage: { ...zeroUsage, inputTokens: 500, outputTokens: 90, apiCallCount: 3 },
  });
  return source;
}

type Msg = Omit<StoredMessage, 'id' | 'timestamp' | 'sessionId'>;

async function append(store: SessionStore, sessionId: string, msgs: Msg[]) {
  const out: StoredMessage[] = [];
  for (const m of msgs) out.push(await store.appendMessage({ ...m, sessionId }));
  return out;
}

const TOOL_TURN: Msg[] = [
  { role: 'user', content: 'read it' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 't1', name: 'read_file', input: { path: 'a' } },
      { id: 't2', name: 'read_file', input: { path: 'b' } },
    ],
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
    traceId: 'trace-1',
  },
  { role: 'tool_result', content: 'A', toolCallId: 't1', toolName: 'read_file', isError: false },
  { role: 'tool_result', content: 'B', toolCallId: 't2', toolName: 'read_file', isError: true },
  { role: 'assistant', content: 'done' },
];

describe('forkSession', () => {
  it('copies the session shape, stamps parentSessionId and zeroes usage', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    const { session } = await forkSession(store, source.id, { key: 'cli:proj:fork:1' });

    expect(session.key).toBe('cli:proj:fork:1');
    expect(session.parentSessionId).toBe(source.id);
    expect(session).toMatchObject({
      platform: 'cli',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      personalityId: 'researcher',
      workingDir: '/work/proj',
      title: 'Planning',
      metadata: { pinnedTools: ['read_file'] },
    });
    expect(session.usage).toEqual(zeroUsage);
  });

  it('personalityId overrides the inherited one', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    const { session } = await forkSession(store, source.id, { key: 'k', personalityId: 'coach' });
    expect(session.personalityId).toBe('coach');
  });

  it('refuses an unknown source with SESSION_NOT_FOUND', async () => {
    const store = new InMemorySessionStore();
    const err = await forkSession(store, 'nope', { key: 'k' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).toBe('SESSION_NOT_FOUND');
    expect((err as EthosError).message).toBe('session not found: nope');
  });

  it('replays the full history past 10k messages, in order', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    const N = 10_050;
    for (let i = 0; i < N; i++) {
      await store.appendMessage({
        sessionId: source.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
      });
    }
    const { session } = await forkSession(store, source.id, { key: 'k' });
    const copied = await store.getMessages(session.id);
    expect(copied).toHaveLength(N);
    expect(copied[0]?.content).toBe('m0');
    expect(copied[N - 1]?.content).toBe(`m${N - 1}`);
  });

  it('preserves every StoredMessage field, including contentBlocks on a provider-compaction row', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    const compaction: Msg = {
      role: 'assistant',
      content: '[provider compaction]',
      toolName: '_provider_compaction',
      contentBlocks: [{ type: 'text', text: 'opaque-compaction-payload' }],
    };
    const originals = await append(store, source.id, [...TOOL_TURN, compaction]);

    const { session, idMap } = await forkSession(store, source.id, { key: 'k' });
    const copied = await store.getMessages(session.id);
    expect(copied).toHaveLength(originals.length);

    const strip = ({ id: _i, sessionId: _s, timestamp: _t, ...rest }: StoredMessage) => rest;
    expect(copied.map(strip)).toEqual(originals.map(strip));
    for (const m of copied) expect(m.sessionId).toBe(session.id);

    // idMap: every source id maps onto the row actually in the fork, in order.
    expect([...idMap.keys()]).toEqual(originals.map((m) => m.id));
    expect([...idMap.values()].map((m) => m.id)).toEqual(copied.map((m) => m.id));
  });

  it('upToMessageId stops after that message', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    const originals = await append(store, source.id, [
      ...TOOL_TURN,
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'after' },
    ]);
    const cut = originals[4]; // the 'done' assistant row closing the tool turn
    if (!cut) throw new Error('fixture');
    const { session, idMap } = await forkSession(store, source.id, {
      key: 'k',
      upToMessageId: cut.id,
    });
    const copied = await store.getMessages(session.id);
    expect(copied.map((m) => m.content)).toEqual(TOOL_TURN.map((m) => m.content));
    expect(idMap.size).toBe(5);
  });

  it('refuses a cut that splits a tool_use from its tool_result, and creates nothing', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    const originals = await append(store, source.id, TOOL_TURN);
    // Cut at the first tool_result: t2's result is after the cut.
    for (const cut of [originals[1], originals[2]]) {
      if (!cut) throw new Error('fixture');
      const err = await forkSession(store, source.id, { key: 'k', upToMessageId: cut.id }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EthosError);
      expect((err as EthosError).code).toBe('INVALID_INPUT');
    }
    expect(await store.listSessions({ parentSessionId: source.id })).toEqual([]);
  });

  it('allows a cut after a tool call that was never answered anywhere', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    const originals = await append(store, source.id, [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'bash', input: {} }] },
    ]);
    const cut = originals[1];
    if (!cut) throw new Error('fixture');
    const { session } = await forkSession(store, source.id, { key: 'k', upToMessageId: cut.id });
    expect(await store.getMessages(session.id)).toHaveLength(2);
  });

  it('refuses an upToMessageId from another session', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    await append(store, source.id, TOOL_TURN);
    const err = await forkSession(store, source.id, { key: 'k', upToMessageId: 'msg_x' }).catch(
      (e: unknown) => e,
    );
    expect((err as EthosError).code).toBe('INVALID_INPUT');
  });

  it('deletes the half-built fork when a copy fails midway, then rethrows', async () => {
    const store = new InMemorySessionStore();
    const source = await seedSource(store);
    await append(store, source.id, TOOL_TURN);

    let appends = 0;
    const realAppend = store.appendMessage.bind(store);
    store.appendMessage = async (m) => {
      if (m.sessionId !== source.id && ++appends === 3) throw new Error('disk full');
      return realAppend(m);
    };

    await expect(forkSession(store, source.id, { key: 'cli:proj:fork:x' })).rejects.toThrow(
      'disk full',
    );
    expect(await store.getSessionByKey('cli:proj:fork:x')).toBeNull();
    expect(await store.listSessions({ parentSessionId: source.id })).toEqual([]);
  });
});
