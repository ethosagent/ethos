import { InMemorySessionStore } from '@ethosagent/core';
import { REWIND_NOTICE, REWIND_USAGE } from '@ethosagent/surface-kit';
import { describe, expect, it } from 'vitest';
import { commitRewind, prepareRewind, rewindPointsFor } from '../session-rewind';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

async function seeded() {
  const store = new InMemorySessionStore();
  const root = await store.createSession({
    key: 'cli:proj',
    platform: 'cli',
    model: 'm',
    provider: 'p',
    personalityId: 'researcher',
    usage,
  });
  await store.appendMessage({ sessionId: root.id, role: 'user', content: 'first' });
  await store.appendMessage({ sessionId: root.id, role: 'assistant', content: 'a1' });
  await store.appendMessage({ sessionId: root.id, role: 'user', content: 'second' });
  await store.appendMessage({ sessionId: root.id, role: 'assistant', content: 'a2' });
  return { store, root };
}

describe('CLI rewind (prepareRewind / commitRewind)', () => {
  it('prepareRewind returns the prompt N back without creating a branch', async () => {
    const { store, root } = await seeded();
    const out = await prepareRewind(store, '', 'cli:proj');
    expect(out.pending?.text).toBe('second');
    expect(out.pending?.turnsBack).toBe(1);
    expect(out.message).toBe(
      `Editing prompt 1 back. Enter runs it on a new branch; an empty line or any /command cancels. ${REWIND_NOTICE}`,
    );
    expect(await store.listSessions({ parentSessionId: root.id })).toEqual([]);
  });

  it('prepareRewind refuses bad and out-of-range N with fixed copy', async () => {
    const { store } = await seeded();
    expect((await prepareRewind(store, 'x', 'cli:proj')).message).toBe(REWIND_USAGE);
    const out = await prepareRewind(store, '9', 'cli:proj');
    expect(out.message).toBe('Only 2 prompts in this session.');
    expect(out.pending).toBeUndefined();
  });

  it('prepareRewind says so when there is no session', async () => {
    const store = new InMemorySessionStore();
    expect((await prepareRewind(store, '', 'cli:none')).message).toBe(
      'Nothing to rewind yet — send a message first.',
    );
  });

  it('prepareRewind notes dropped attachments', async () => {
    const { store, root } = await seeded();
    await store.appendMessage({
      sessionId: root.id,
      role: 'user',
      content: '<attachments>\nx\n</attachments>\n\nlook',
    });
    const out = await prepareRewind(store, '1', 'cli:proj');
    expect(out.pending?.hadAttachments).toBe(true);
    expect(out.message.endsWith(' Attached files are not re-sent.')).toBe(true);
  });

  it('rewindPointsFor lists points newest first', async () => {
    const { store } = await seeded();
    expect((await rewindPointsFor(store, 'cli:proj')).map((p) => p.text)).toEqual([
      'second',
      'first',
    ]);
    expect(await rewindPointsFor(store, 'cli:none')).toEqual([]);
  });

  it('commitRewind re-keys onto a <source-key>:fork:<ts>-<hex> child parented at the root', async () => {
    const { store, root } = await seeded();
    const pending = (await prepareRewind(store, '2', 'cli:proj')).pending;
    if (!pending) throw new Error('no pending');
    const out = await commitRewind(store, 'cli:proj', pending.messageId);
    expect(out.switchTo.sessionKey).toMatch(/^cli:proj:fork:\d+-[0-9a-f]{8}$/);
    expect(out.switchTo.personalityId).toBe('researcher');
    expect(out.message).toBe(
      'Rewound — now on a new branch. /branches lists them, /branch <n> switches.',
    );
    const child = await store.getSessionByKey(out.switchTo.sessionKey);
    expect(child?.parentSessionId).toBe(root.id);
    expect(await store.getMessages(child?.id ?? '')).toEqual([]);
  });
});
