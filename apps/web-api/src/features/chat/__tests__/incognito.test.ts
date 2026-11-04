import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { isEthosError } from '@ethosagent/types';
import type { ActivityEvent, SseEvent } from '@ethosagent/web-contracts';
import { incognitoSessionMetadata, isIncognitoSession } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStubAgentLoop } from '../../../__tests__/test-helpers';
import { ChatRepository } from '../repository';
import { ChatService } from '../service';

// Plan incognito-sessions D5/D6/D7, web part: a new chat can be created
// incognito, an existing session's stamp always wins, and `endIncognito`
// scrubs the transcript and drops cards and attachments for that key.

describe('ChatService incognito', () => {
  let store: SQLiteSessionStore;
  let sessions: ChatRepository;
  let buffer: SessionStreamBuffer<SseEvent>;
  let activityBuffer: SessionStreamBuffer<ActivityEvent>;
  let runOpts: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    sessions = new ChatRepository(store);
    buffer = new SessionStreamBuffer<SseEvent>();
    activityBuffer = new SessionStreamBuffer<ActivityEvent>();
    runOpts = [];
  });

  afterEach(() => {
    buffer.destroy();
    activityBuffer.destroy();
    store.close();
  });

  function makeService(extra: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) {
    const loop = makeStubAgentLoop({
      events: [{ type: 'done', text: 'ok', turnCount: 1 }],
      onRun: (_input, opts) => runOpts.push(opts as Record<string, unknown>),
    });
    return new ChatService({
      loop,
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      ...extra,
    });
  }

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
  }

  it('send with incognito and no sessionId stamps the new session and runs it incognito', async () => {
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 't', text: 'hi', incognito: true });
    const row = await sessions.get(sessionId);
    expect(row).not.toBeNull();
    expect(row && isIncognitoSession(row)).toBe(true);
    expect(row?.metadata).toEqual(incognitoSessionMetadata());
    await settle();
    expect(runOpts[0]?.incognito).toBe(true);
  });

  it('send without incognito leaves a new session unstamped', async () => {
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 't', text: 'hi' });
    const row = await sessions.get(sessionId);
    expect(row && isIncognitoSession(row)).toBe(false);
    await settle();
    expect(runOpts[0]?.incognito).toBeUndefined();
  });

  it('send with incognito:false to an incognito session stays incognito', async () => {
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 't', text: 'one', incognito: true });
    await settle();
    await service.send({ sessionId, clientId: 't', text: 'two', incognito: false });
    await settle();
    const row = await sessions.get(sessionId);
    expect(row && isIncognitoSession(row)).toBe(true);
    expect(runOpts[1]?.incognito).toBe(true);
  });

  it('send with incognito:true to a normal session does not stamp it', async () => {
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 't', text: 'one' });
    await settle();
    await service.send({ sessionId, clientId: 't', text: 'two', incognito: true });
    await settle();
    const row = await sessions.get(sessionId);
    expect(row && isIncognitoSession(row)).toBe(false);
    expect(runOpts[1]?.incognito).toBeUndefined();
  });

  it('endIncognito scrubs the transcript and clears cards and attachments for the key', async () => {
    const deleteSession = vi.fn();
    const clear = vi.fn(async () => {});
    const service = makeService({
      cardStore: { deleteSession } as unknown as NonNullable<
        ConstructorParameters<typeof ChatService>[0]['cardStore']
      >,
      attachmentCache: { clear } as unknown as NonNullable<
        ConstructorParameters<typeof ChatService>[0]['attachmentCache']
      >,
    });
    const { sessionId } = await service.send({ clientId: 't', text: 'secret', incognito: true });
    await settle();
    await store.appendMessage({ sessionId, role: 'user', content: 'secret plans' });

    const out = await service.endIncognito(sessionId);
    expect(out.scrubbed).toBeGreaterThan(0);
    const msgs = await store.getMessages(sessionId);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every((m) => m.content === '')).toBe(true);
    expect(deleteSession).toHaveBeenCalledWith(sessionId);
    const row = await sessions.get(sessionId);
    expect(clear).toHaveBeenCalledWith(row?.key);
  });

  it('endIncognito waits for the aborted turn, so a late write cannot land after the scrub', async () => {
    let onAbort: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
    });
    let sessionId = '';
    const loop = {
      hooks: makeStubAgentLoop().hooks,
      async *run(_input: string, opts: { abortSignal?: AbortSignal }) {
        opts.abortSignal?.addEventListener('abort', () => onAbort(), { once: true });
        await aborted;
        // The unwinding turn still writes its partial reply after the abort.
        await new Promise((r) => setTimeout(r, 60));
        await store.appendMessage({ sessionId, role: 'assistant', content: 'late secret' });
        yield { type: 'done', text: 'x', turnCount: 1 };
      },
    } as unknown as ConstructorParameters<typeof ChatService>[0]['loop'];
    const service = new ChatService({
      loop,
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
    ({ sessionId } = await service.send({ clientId: 't', text: 'hi', incognito: true }));
    await settle();

    await service.endIncognito(sessionId);

    const msgs = await store.getMessages(sessionId);
    expect(msgs.length).toBe(1); // the late write happened
    expect(msgs.every((m) => m.content === '')).toBe(true);
  });

  it('endIncognito refuses a session that is not incognito', async () => {
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 't', text: 'hi' });
    await settle();
    await expect(service.endIncognito(sessionId)).rejects.toSatisfy(
      (err) => isEthosError(err) && err.code === 'INVALID_INPUT',
    );
    const msgs = await store.getMessages(sessionId);
    expect(msgs.every((m) => m.content !== '')).toBe(true);
  });

  it('endIncognito on an unknown session throws SESSION_NOT_FOUND', async () => {
    const service = makeService();
    await expect(service.endIncognito('nope')).rejects.toSatisfy(
      (err) => isEthosError(err) && err.code === 'SESSION_NOT_FOUND',
    );
  });

  describe('card persistence', () => {
    const card = { kind: 'text', specVersion: 1, payload: { text: 'hello' } };

    async function toolEndFor(incognito: boolean) {
      const append = vi.fn();
      const events = [
        { type: 'tool_start', toolCallId: 'tc1', toolName: 'demo', args: {} },
        {
          type: 'tool_end',
          toolCallId: 'tc1',
          toolName: 'demo',
          ok: true,
          durationMs: 1,
          result: 'ok',
          structured: { card },
        },
        { type: 'done', text: 'ok', turnCount: 1 },
      ] as never;
      const loop = makeStubAgentLoop({ events });
      const service = new ChatService({
        loop,
        sessions,
        buffer,
        activityBuffer,
        defaults: { model: 'claude-test', provider: 'anthropic' },
        cardStore: { append } as unknown as NonNullable<
          ConstructorParameters<typeof ChatService>[0]['cardStore']
        >,
      });
      await service.send({ clientId: 't', text: 'hi', ...(incognito ? { incognito: true } : {}) });
      await settle();
      return append;
    }

    it('writes nothing to the card store for an incognito session', async () => {
      expect((await toolEndFor(true)).mock.calls).toEqual([]);
    });

    it('writes the card for a normal session', async () => {
      expect((await toolEndFor(false)).mock.calls.length).toBe(1);
    });
  });
});
