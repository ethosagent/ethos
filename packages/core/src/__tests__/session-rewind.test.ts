import type { Session, SessionStore, StoredMessage } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildAttachmentAnnotation } from '../attachment-annotation';
import { isIncognitoSession } from '../chat-audience';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { forkSession, listBranches } from '../session-fork';
import { editablePromptText, listRewindPoints, rewindSession } from '../session-rewind';
import { buildVoiceOriginAnnotation } from '../voice-origin';

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

type Role = StoredMessage['role'];

async function seed(
  store: SessionStore,
  rows: Array<[Role, string]>,
  metadata?: Record<string, unknown>,
): Promise<Session> {
  const s = await store.createSession({
    key: `cli:t:${Math.random()}`,
    platform: 'cli',
    model: 'm',
    provider: 'p',
    ...(metadata ? { metadata } : {}),
    usage: zeroUsage,
  });
  for (const [role, content] of rows) await store.appendMessage({ sessionId: s.id, role, content });
  return s;
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof EthosError ? e.code : 'OTHER';
  }
  return undefined;
}

const ABAB: Array<[Role, string]> = [
  ['user', 'a'],
  ['assistant', 'A'],
  ['user', 'b'],
  ['assistant', 'B'],
];

describe('session rewind', () => {
  it('lists user prompts newest first and skips user_steer', async () => {
    const store = new InMemorySessionStore();
    const s = await seed(store, [
      ['user', 'a'],
      ['assistant', 'x'],
      ['user', 'b'],
      ['user_steer', 's'],
      ['assistant', 'y'],
      ['user', 'c'],
    ]);
    expect((await listRewindPoints(store, s.id)).map((p) => [p.turnsBack, p.text])).toEqual([
      [1, 'c'],
      [2, 'b'],
      [3, 'a'],
    ]);
  });

  it('returns [] for an unknown session', async () => {
    expect(await listRewindPoints(new InMemorySessionStore(), 'nope')).toEqual([]);
  });

  it('editablePromptText strips the attachments block and the voice block', () => {
    const content = `${buildAttachmentAnnotation([{ type: 'image', ref: 'r', url: 'u', mimeType: 'image/png' }])}\n\n${buildVoiceOriginAnnotation({ transport: 'browser', speaker: 'owner' })}\n\nwhat is this`;
    expect(editablePromptText(content)).toEqual({ text: 'what is this', hadAttachments: true });
    expect(editablePromptText('plain')).toEqual({ text: 'plain', hadAttachments: false });
  });

  it('editablePromptText strips a voice block alone and flags contentBlocks', () => {
    const voice = `${buildVoiceOriginAnnotation({ transport: 'browser', speaker: 'owner' })}\n\nhello`;
    expect(editablePromptText(voice)).toEqual({ text: 'hello', hadAttachments: false });
    expect(editablePromptText('x', [{ type: 'image' }])).toEqual({
      text: 'x',
      hadAttachments: true,
    });
  });

  it('rewindSession forks just before the target prompt, parented at the family root', async () => {
    const store = new InMemorySessionStore();
    const R = await seed(store, ABAB);
    const { session: F } = await forkSession(store, R.id, { key: 'cli:f' });
    const { session, point } = await rewindSession(store, F.id, {
      key: 'k',
      target: { turnsBack: 1 },
    });
    expect(point.text).toBe('b');
    expect(session.parentSessionId).toBe(R.id);
    expect((await store.getMessages(session.id)).map((m) => m.content)).toEqual(['a', 'A']);
    expect((await listBranches(store, session.id)).map((s) => s.id)).toContain(F.id);
  });

  it('targets by messageId', async () => {
    const store = new InMemorySessionStore();
    const R = await seed(store, ABAB);
    const pts = await listRewindPoints(store, R.id);
    const { session, point } = await rewindSession(store, R.id, {
      key: 'k',
      target: { messageId: pts[1]?.messageId ?? '' },
    });
    expect(point.text).toBe('a');
    expect(session.parentSessionId).toBe(R.id);
  });

  it('rewinding the first prompt yields an empty branch', async () => {
    const store = new InMemorySessionStore();
    const R = await seed(store, ABAB);
    const { session } = await rewindSession(store, R.id, { key: 'k', target: { turnsBack: 2 } });
    expect(await store.getMessages(session.id)).toEqual([]);
  });

  it('refuses turnsBack out of range, a non-user messageId, and an unknown session', async () => {
    const store = new InMemorySessionStore();
    const R = await seed(store, ABAB);
    const rows = await store.getMessages(R.id);
    expect(await code(rewindSession(store, R.id, { key: 'k', target: { turnsBack: 0 } }))).toBe(
      'INVALID_INPUT',
    );
    expect(await code(rewindSession(store, R.id, { key: 'k', target: { turnsBack: 3 } }))).toBe(
      'INVALID_INPUT',
    );
    expect(
      await code(
        rewindSession(store, R.id, { key: 'k', target: { messageId: rows[1]?.id ?? '' } }),
      ),
    ).toBe('INVALID_INPUT');
    expect(await code(rewindSession(store, 'nope', { key: 'k', target: { turnsBack: 1 } }))).toBe(
      'SESSION_NOT_FOUND',
    );
  });

  it('an incognito source yields an incognito branch', async () => {
    const store = new InMemorySessionStore();
    const R = await seed(store, ABAB, { incognito: true });
    const { session } = await rewindSession(store, R.id, { key: 'k', target: { turnsBack: 1 } });
    expect(isIncognitoSession(session)).toBe(true);
  });
});
