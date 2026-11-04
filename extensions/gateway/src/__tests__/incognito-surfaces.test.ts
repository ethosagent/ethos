// Incognito on the gateway surface — review fixes: ending / rotating an
// incognito lane waits for the aborted turn before it scrubs, and an incognito
// lane refuses to switch onto a normal branch.

import type { AgentLoop } from '@ethosagent/core';
import { InMemorySessionStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  Session,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';

const LANE = 'telegram:bot-a:chat-1';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

/** In-memory store with the scrub the SQLite store has: blank content under a key. */
class ScrubbingStore extends InMemorySessionStore {
  scrubbed: string[] = [];
  async scrubIncognito(opts: { sessionKey?: string }) {
    const key = opts.sessionKey ?? '';
    const s = await this.getSessionByKey(key);
    this.scrubbed.push(key);
    if (!s) return { messages: 0, sessionIds: [] };
    const msgs = await this.getMessages(s.id);
    // InMemorySessionStore returns live objects: blanking in place is the scrub.
    for (const m of msgs) m.content = '';
    return { messages: msgs.length, sessionIds: [s.id] };
  }
}

function recordingAdapter() {
  const sends: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function msg(text: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text,
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
  };
}

/**
 * A loop that creates the (incognito-stamped) session on its first turn and,
 * when `lateWriteMs` is set, keeps writing that long AFTER its abort fires —
 * the unwinding turn the scrub must wait for. `hangForever` ignores the abort.
 */
function loopFor(
  store: ScrubbingStore,
  opts: { lateWriteMs?: number; hangForever?: boolean; neverEndsAfterFirst?: boolean } = {},
) {
  let turns = 0;
  const lateWrites: string[] = [];
  const run = vi.fn(
    (text: string, o: { sessionKey?: string; incognito?: boolean; abortSignal?: AbortSignal }) => {
      const key = o.sessionKey ?? LANE;
      const n = ++turns;
      return (async function* () {
        let s = await store.getSessionByKey(key);
        if (!s) {
          s = await store.createSession({
            key,
            platform: 'telegram',
            model: 'm',
            provider: 'p',
            personalityId: 'default',
            usage,
            ...(o.incognito ? { metadata: { incognito: true, roomAudience: 'shared' } } : {}),
          } as Omit<Session, 'id' | 'createdAt' | 'updatedAt'>);
        }
        await store.appendMessage({ sessionId: s.id, role: 'user', content: text });
        if (n === 2 && (opts.lateWriteMs !== undefined || opts.hangForever)) {
          await new Promise<void>((resolve) => {
            o.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
          if (opts.hangForever) await new Promise(() => {});
          await new Promise((r) => setTimeout(r, opts.lateWriteMs));
          await store.appendMessage({
            sessionId: s.id,
            role: 'assistant',
            content: 'partial secret',
          });
          lateWrites.push('partial secret');
          return;
        }
        yield { type: 'done', text: 'reply', turnCount: 1 };
      })();
    },
  );
  return {
    loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } },
    lateWrites,
  };
}

function gateway(
  loop: unknown,
  adapter: PlatformAdapter,
  store: ScrubbingStore,
  extra: Partial<GatewayConfig> = {},
) {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default', allowSlashSwitch: true },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    storage: new InMemoryStorage(),
    dataDir: '/state',
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    sessionStore: () => store,
    personalityDirectory: undefined,
    ...extra,
  } as GatewayConfig);
}

async function contentOf(store: ScrubbingStore, key: string): Promise<string> {
  const s = await store.getSessionByKey(key);
  return JSON.stringify(s ? await store.getMessages(s.id) : []);
}

async function laneKeyOf(gw: Gateway, out: ReturnType<typeof recordingAdapter>): Promise<string> {
  await gw.handleMessage(msg('/status'), out.adapter);
  const line = (out.sends.at(-1) ?? '').split('\n').find((l) => l.includes(' · ')) ?? '';
  return line.split(' · ').at(-1) ?? '';
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('incognito lane ends — the aborted turn settles before the scrub (fix 1)', () => {
  it('/new waits for a turn that keeps writing after the abort', async () => {
    const store = new ScrubbingStore();
    const out = recordingAdapter();
    const l = loopFor(store, { lateWriteMs: 60 });
    const gw = gateway(l.loop, out.adapter, store);
    await gw.handleMessage(msg('/incognito'), out.adapter);
    await gw.handleMessage(msg('first secret'), out.adapter);
    const key = await laneKeyOf(gw, out);
    void gw.handleMessage(msg('second secret'), out.adapter);
    await waitUntil(() => l.loop.run.mock.calls.length === 2);

    await gw.handleMessage(msg('/new'), out.adapter);

    expect(l.lateWrites).toEqual(['partial secret']); // the turn did write after the abort
    expect(await contentOf(store, key)).not.toContain('secret');
    expect(out.sends.at(-1)).toBe(
      'Incognito off. That chat’s history was cleared. New session started.',
    );
  });

  it('a turn that never settles: /new scrubs anyway after the grace and records it', async () => {
    const store = new ScrubbingStore();
    const out = recordingAdapter();
    const l = loopFor(store, { hangForever: true });
    const recordSafetyBlock = vi.fn();
    const gw = gateway(l.loop, out.adapter, store, {
      observability: { recordSafetyBlock } as unknown as GatewayConfig['observability'],
    });
    await gw.handleMessage(msg('/incognito'), out.adapter);
    await gw.handleMessage(msg('first secret'), out.adapter);
    void gw.handleMessage(msg('second secret'), out.adapter);
    await waitUntil(() => l.loop.run.mock.calls.length === 2);

    await gw.handleMessage(msg('/new'), out.adapter);

    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'gateway.incognito_abort_unsettled' }),
    );
    expect(store.scrubbed).toHaveLength(1);
    expect(out.sends.at(-1)).toMatch(/^Incognito off\./);
  }, 8000);
});

describe('/personality on an incognito lane scrubs the session it leaves (fix 5)', () => {
  it('blanks the rotated-away session, after the aborted turn settles', async () => {
    const store = new ScrubbingStore();
    const out = recordingAdapter();
    const l = loopFor(store, { lateWriteMs: 60 });
    const gw = gateway(l.loop, out.adapter, store, {
      personalityDirectory: { has: () => true, list: () => [], refresh: async () => {} },
    } as Partial<GatewayConfig>);
    await gw.handleMessage(msg('/incognito'), out.adapter);
    await gw.handleMessage(msg('first secret'), out.adapter);
    const oldKey = await laneKeyOf(gw, out);
    void gw.handleMessage(msg('second secret'), out.adapter);
    await waitUntil(() => l.loop.run.mock.calls.length === 2);
    await new Promise((r) => setTimeout(r, 5));

    await gw.handleMessage(msg('/personality alt'), out.adapter);
    await new Promise((r) => setTimeout(r, 120)); // a turn that was not awaited would write here

    expect(await contentOf(store, oldKey)).not.toContain('secret');
    expect(store.scrubbed).toContain(oldKey);
    expect(await laneKeyOf(gw, out)).not.toBe(oldKey);
    expect(out.sends.at(-1)).toContain('Incognito: on'); // still incognito
  });

  it('a normal lane is not scrubbed by /personality', async () => {
    const store = new ScrubbingStore();
    const out = recordingAdapter();
    const gw = gateway(loopFor(store).loop, out.adapter, store, {
      personalityDirectory: { has: () => true, list: () => [], refresh: async () => {} },
    } as Partial<GatewayConfig>);
    await gw.handleMessage(msg('/personality alt'), out.adapter);
    expect(store.scrubbed).toEqual([]);
  });
});

describe('an incognito lane will not switch onto a normal branch (fix 2)', () => {
  async function setup(childMetadata: Record<string, unknown> | undefined) {
    const store = new ScrubbingStore();
    const out = recordingAdapter();
    const l = loopFor(store);
    const gw = gateway(l.loop, out.adapter, store);
    await gw.handleMessage(msg('/incognito'), out.adapter);
    await gw.handleMessage(msg('hi'), out.adapter);
    const key = await laneKeyOf(gw, out);
    const root = await store.getSessionByKey(key);
    await store.createSession({
      key: `${key}:fork:1-aaaaaaaa`,
      platform: 'telegram',
      model: 'm',
      provider: 'p',
      personalityId: 'default',
      usage,
      parentSessionId: root?.id,
      ...(childMetadata ? { metadata: childMetadata } : {}),
    } as Omit<Session, 'id' | 'createdAt' | 'updatedAt'>);
    return { gw, out, key };
  }

  it('refuses a non-incognito target and leaves the lane where it was', async () => {
    const { gw, out, key } = await setup(undefined);
    await gw.handleMessage(msg('/branch 2'), out.adapter);
    expect(out.sends.at(-1)).toBe(
      'That branch is not incognito. Send /new to leave incognito first.',
    );
    expect(await laneKeyOf(gw, out)).toBe(key);
  });

  it('allows an incognito target', async () => {
    const { gw, out, key } = await setup({ incognito: true, roomAudience: 'shared' });
    await gw.handleMessage(msg('/branch 2'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ Switched to branch 2.');
    expect(await laneKeyOf(gw, out)).toBe(`${key}:fork:1-aaaaaaaa`);
  });
});
