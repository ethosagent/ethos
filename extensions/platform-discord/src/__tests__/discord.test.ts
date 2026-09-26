import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chunkText, DiscordAdapter, reflowChunks } from '../index';
import { loadDiscordSdk } from '../sdk';

describe('Discord chunkText', () => {
  it('returns single chunk when within limit', () => {
    expect(chunkText('hello', 2000)).toEqual(['hello']);
  });

  it('splits long text at newline boundary', () => {
    const text = 'line one\n'.repeat(300); // ~2700 chars
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
  });

  it('splits at character limit when no newline', () => {
    const text = 'x'.repeat(3000);
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe(text);
  });

  it('preserves all content', () => {
    const text = 'Hello world. '.repeat(200);
    const chunks = chunkText(text, 2000);
    expect(chunks.join('')).toBe(text);
  });
});

describe('reflowChunks', () => {
  function makeOps() {
    const edits: Array<[string, string]> = [];
    const appends: string[] = [];
    const deletes: string[] = [];
    let nextNewId = 100;
    return {
      edits,
      appends,
      deletes,
      ops: {
        edit: async (id: string, text: string) => {
          edits.push([id, text]);
          return id;
        },
        append: async (text: string) => {
          appends.push(text);
          return String(nextNewId++);
        },
        deleteId: async (id: string) => {
          deletes.push(id);
        },
      },
    };
  }

  it('edits in place when chunk count is unchanged', async () => {
    const t = makeOps();
    const result = await reflowChunks(['a', 'b'], ['1', '2'], t.ops);
    expect(result).toEqual(['1', '2']);
    expect(t.edits).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
    expect(t.appends).toEqual([]);
    expect(t.deletes).toEqual([]);
  });

  it('appends new messages when new text has more chunks', async () => {
    const t = makeOps();
    const result = await reflowChunks(['a', 'b', 'c'], ['1'], t.ops);
    expect(result).toEqual(['1', '100', '101']);
    expect(t.edits).toEqual([['1', 'a']]);
    expect(t.appends).toEqual(['b', 'c']);
    expect(t.deletes).toEqual([]);
  });

  it('deletes trailing chunks when new text has fewer chunks', async () => {
    const t = makeOps();
    const result = await reflowChunks(['only'], ['1', '2', '3'], t.ops);
    expect(result).toEqual(['1']);
    expect(t.edits).toEqual([['1', 'only']]);
    expect(t.appends).toEqual([]);
    expect(t.deletes).toEqual(['2', '3']);
  });

  it('swallows delete failures (best-effort)', async () => {
    const t = makeOps();
    const ops = {
      ...t.ops,
      deleteId: async (_id: string) => {
        throw new Error('boom');
      },
    };
    await expect(reflowChunks(['a'], ['1', '2'], ops)).resolves.toEqual(['1']);
  });
});

// H1 / UD4 (ux-feedback-and-config-clarity) — the "Thinking…" placeholder is
// on by default and posted once per TURN: the gateway's periodic typing
// refresh reuses the current turn's placeholder, a delivered reply clears it,
// and a >30s typing gap (a turn that ended without a reply) replaces the
// stale one instead of blocking the chat forever.
describe('DiscordAdapter thinking placeholder', () => {
  beforeAll(async () => {
    await loadDiscordSdk();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAdapter(config: { postThinkingPlaceholder?: boolean } = {}) {
    const adapter = new DiscordAdapter({ token: 'fake-token', botKey: 'test-bot', ...config });
    const sent: Array<{ content?: string }> = [];
    let n = 0;
    const send = vi.fn(async (payload: { content?: string }) => {
      sent.push(payload);
      n++;
      return { id: `m${n}` };
    });
    const deleted: string[] = [];
    const messagesFetch = vi.fn(async (id: string) => ({
      delete: async () => {
        deleted.push(id);
      },
    }));
    const channel = {
      send,
      sendTyping: vi.fn(async () => {}),
      messages: { fetch: messagesFetch },
    };
    (adapter as unknown as { client: { channels: unknown } }).client = {
      channels: { fetch: vi.fn(async () => channel) },
    } as never;
    return { adapter, sent, deleted };
  }

  const thinking = (sent: Array<{ content?: string }>) =>
    sent.filter((p) => p.content === 'Thinking…');

  it('posts a placeholder by default, once per turn — typing refreshes reuse it', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.sendTyping('chan-1');
    await adapter.sendTyping('chan-1'); // the gateway's ~4s refresh
    expect(thinking(sent)).toHaveLength(1);
  });

  it('the reply clears the placeholder and the next turn posts a fresh one', async () => {
    const { adapter, sent, deleted } = makeAdapter();
    await adapter.sendTyping('chan-1');
    await adapter.send('chan-1', { text: 'answer' });
    expect(deleted).toEqual(['m1']);
    await adapter.sendTyping('chan-1');
    expect(thinking(sent)).toHaveLength(2);
  });

  it('a turn that ended without a reply leaves a stale placeholder; the next turn replaces it', async () => {
    vi.useFakeTimers();
    const { adapter, sent, deleted } = makeAdapter();
    await adapter.sendTyping('chan-1');
    expect(thinking(sent)).toHaveLength(1);
    // Within the liveness window: still the same turn, no second post.
    vi.advanceTimersByTime(4_000);
    await adapter.sendTyping('chan-1');
    expect(thinking(sent)).toHaveLength(1);
    // Past the window: the previous turn is over — stale message deleted,
    // fresh placeholder posted for the new turn.
    vi.advanceTimersByTime(31_000);
    await adapter.sendTyping('chan-1');
    expect(deleted).toEqual(['m1']);
    expect(thinking(sent)).toHaveLength(2);
  });

  it('an explicit postThinkingPlaceholder: false suppresses the placeholder', async () => {
    const { adapter, sent } = makeAdapter({ postThinkingPlaceholder: false });
    await adapter.sendTyping('chan-1');
    expect(sent).toHaveLength(0);
  });
});
