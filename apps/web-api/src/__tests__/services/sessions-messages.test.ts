import { SQLiteCardStore } from '@ethosagent/session-cards';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { MessageRole, StoredMessage } from '@ethosagent/types';
import type { CardEnvelope } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsRepository } from '../../features/sessions/repository';
import { MESSAGE_PAGE_MAX_BYTES, SessionsService } from '../../features/sessions/service';

// `sessions.messages` + `sessions.get({ withMessages })` against real SQLite
// stores. Page semantics themselves are pinned per store in
// extensions/session-sqlite/src/__tests__/message-page.test.ts; these tests
// pin the service layer: cursor codec, error codes, card filtering.

function textCard(text: string): CardEnvelope {
  return { kind: 'text', specVersion: 1, payload: { text } };
}

describe('SessionsService — paged history', () => {
  let store: SQLiteSessionStore;
  let cards: SQLiteCardStore;
  let repo: SessionsRepository;
  let service: SessionsService;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    cards = new SQLiteCardStore(':memory:');
    repo = new SessionsRepository(store);
    service = new SessionsService({ sessions: repo, cards });
  });

  afterEach(() => {
    cards.close();
    store.close();
    vi.restoreAllMocks();
  });

  async function newSession(key: string): Promise<string> {
    return (
      await repo.create({ key, platform: 'web', model: 'claude-test', provider: 'anthropic' })
    ).id;
  }

  async function add(
    sessionId: string,
    role: MessageRole,
    content: string,
    extra: Partial<StoredMessage> = {},
  ): Promise<void> {
    await store.appendMessage({ sessionId, role, content, ...extra });
  }

  /** A turn whose single tool call emitted a card. */
  async function toolTurn(sessionId: string, i: number): Promise<void> {
    await add(sessionId, 'user', `u${i}`);
    await add(sessionId, 'assistant', '', {
      toolCalls: [{ id: `call-${i}`, name: 'emit_card', input: {} }],
    });
    await add(sessionId, 'tool_result', 'card emitted', { toolCallId: `call-${i}` });
    await add(sessionId, 'assistant', `a${i}`);
    cards.append(sessionId, `call-${i}`, textCard(`card ${i}`));
  }

  it('walks newest to oldest and ends with a null cursor', async () => {
    const id = await newSession('web:walk');
    for (let i = 0; i < 5; i++) await toolTurn(id, i);

    const first = await service.messages({ id, turns: 2 });
    expect(first.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'u3',
      'u4',
    ]);
    expect(typeof first.nextCursor).toBe('string');

    const second = await service.messages({ id, turns: 2, before: first.nextCursor ?? '' });
    expect(second.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'u1',
      'u2',
    ]);

    const last = await service.messages({ id, turns: 2, before: second.nextCursor ?? '' });
    expect(last.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['u0']);
    expect(last.nextCursor).toBeNull();
  });

  it('returns only the cards whose tool call belongs to the page', async () => {
    const id = await newSession('web:cards');
    for (let i = 0; i < 3; i++) await toolTurn(id, i);
    const listAll = vi.spyOn(cards, 'list');

    const newest = await service.messages({ id, turns: 1 });
    expect(newest.cards.map((c) => c.toolCallId)).toEqual(['call-2']);
    expect(newest.cards[0]?.envelope).toEqual(textCard('card 2'));

    const older = await service.messages({ id, turns: 2, before: newest.nextCursor ?? '' });
    expect(older.cards.map((c) => c.toolCallId)).toEqual(['call-0', 'call-1']);
    expect(listAll).not.toHaveBeenCalled();
  });

  it('stops a page at MESSAGE_PAGE_MAX_BYTES but still returns one whole turn', async () => {
    const id = await newSession('web:cap');
    const big = 'x'.repeat(Math.ceil(MESSAGE_PAGE_MAX_BYTES * 0.6));
    for (let i = 0; i < 3; i++) {
      await add(id, 'user', `u${i}`);
      await add(id, 'assistant', big);
    }
    const first = await service.messages({ id, turns: 20 });
    expect(first.messages.map((m) => m.content.slice(0, 2))).toEqual(['u2', 'xx']);
    expect(first.nextCursor).not.toBeNull();
  });

  it('rejects a cursor that does not decode with INVALID_INPUT', async () => {
    const id = await newSession('web:bad-cursor');
    await toolTurn(id, 0);
    for (const before of [
      'not a cursor',
      Buffer.from('{"v":2,"m":"x"}').toString('base64url'),
      '',
    ]) {
      await expect(service.messages({ id, turns: 1, before })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
  });

  it("rejects another session's cursor with INVALID_INPUT", async () => {
    const a = await newSession('web:a');
    const b = await newSession('web:b');
    for (let i = 0; i < 2; i++) {
      await toolTurn(a, i);
      await toolTurn(b, i);
    }
    const foreign = (await service.messages({ id: b, turns: 1 })).nextCursor;
    expect(foreign).not.toBeNull();
    await expect(
      service.messages({ id: a, turns: 1, before: foreign ?? '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('throws SESSION_NOT_FOUND for an unknown session, like get', async () => {
    await expect(service.messages({ id: 'missing', turns: 20 })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(service.get('missing', { withMessages: false })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('get with withMessages: false returns empty arrays without reading messages or cards', async () => {
    const id = await newSession('web:light');
    await toolTurn(id, 0);
    const readMessages = vi.spyOn(repo, 'messages');
    const readCards = vi.spyOn(cards, 'list');

    const light = await service.get(id, { withMessages: false });
    expect(light.session.id).toBe(id);
    expect(light.messages).toEqual([]);
    expect(light.cards).toEqual([]);
    expect(readMessages).not.toHaveBeenCalled();
    expect(readCards).not.toHaveBeenCalled();
  });

  it('get still returns every message and card by default', async () => {
    const id = await newSession('web:full');
    await toolTurn(id, 0);
    const full = await service.get(id);
    expect(full.messages).toHaveLength(4);
    expect(full.cards.map((c) => c.toolCallId)).toEqual(['call-0']);
  });
});
