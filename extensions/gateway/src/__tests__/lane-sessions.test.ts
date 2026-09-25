// Session branches in the gateway + the durable lane → session map (plan
// openclaw-9.5-adoption item 5, D28). A second Gateway over the same Storage
// (and spool) is a process restart: empty in-memory maps, the same disk.

import type { AgentLoop } from '@ethosagent/core';
import { InMemorySessionStore } from '@ethosagent/core';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  SessionStore,
  Storage,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';
import { LaneSessionFiles } from '../lane-sessions';

const DATA_DIR = '/state';
const LANE = 'telegram:bot-a:chat-1';

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
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
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

/** A loop that records the session key of every turn. `hang` never finishes one. */
function keyedLoop(hang = false) {
  const turns: Array<{ text: string; sessionKey: string | undefined }> = [];
  const run = vi.fn((text: string, opts: { sessionKey?: string }) => {
    turns.push({ text, sessionKey: opts.sessionKey });
    return (async function* () {
      if (hang) await new Promise(() => {});
      yield { type: 'done', text: 'reply', turnCount: 1 };
    })();
  });
  return { loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } }, turns };
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

function gateway(
  loop: unknown,
  adapter: PlatformAdapter,
  storage: Storage,
  extra: Partial<GatewayConfig> = {},
): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    storage,
    dataDir: DATA_DIR,
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...extra,
  });
}

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

/** A store holding the lane's default session with a short history. */
async function storeWithLaneSession(): Promise<SessionStore> {
  const store = new InMemorySessionStore();
  const root = await store.createSession({
    key: LANE,
    platform: 'telegram',
    model: 'm',
    provider: 'p',
    personalityId: 'default',
    usage,
  });
  await store.appendMessage({ sessionId: root.id, role: 'user', content: 'hi' });
  await store.appendMessage({ sessionId: root.id, role: 'assistant', content: 'hello' });
  return store;
}

describe('gateway lane → session map survives a restart (D28)', () => {
  it('/new survives a restart', async () => {
    const storage = new InMemoryStorage();
    const out = recordingAdapter();
    const first = keyedLoop();
    const gw1 = gateway(first.loop, out.adapter, storage);
    await gw1.restoreLaneSessions();
    await gw1.handleMessage(msg('/new'), out.adapter);
    await gw1.handleMessage(msg('one'), out.adapter);
    const afterNew = first.turns[0]?.sessionKey ?? '';
    expect(afterNew).toMatch(new RegExp(`^${LANE}:\\d+$`));

    const second = keyedLoop();
    const gw2 = gateway(second.loop, out.adapter, storage);
    await gw2.restoreLaneSessions();
    await gw2.handleMessage(msg('two'), out.adapter);
    expect(second.turns[0]?.sessionKey).toBe(afterNew);
  });

  it('without a restore the lane falls back to its default — the restore is what carries it', async () => {
    const storage = new InMemoryStorage();
    const out = recordingAdapter();
    await gateway(keyedLoop().loop, out.adapter, storage).handleMessage(msg('/new'), out.adapter);
    const second = keyedLoop();
    await gateway(second.loop, out.adapter, storage).handleMessage(msg('two'), out.adapter);
    expect(second.turns[0]?.sessionKey).toBe(LANE);
  });

  it('a spool row left by a crash after /new is replayed into the post-/new session', async () => {
    const storage = new InMemoryStorage();
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const spoolCfg = { inboundSpool: spool, inboundSpoolOptions: { replayIntervalMs: 0 } };

    const first = keyedLoop(true); // the turn never ends: a kill -9 analogue
    const gw1 = gateway(first.loop, out.adapter, storage, spoolCfg);
    await gw1.handleMessage(msg('/new'), out.adapter);
    void gw1.handleMessage(msg('lost in the crash'), out.adapter);
    await waitUntil(() => first.turns.length === 1);
    const postNew = first.turns[0]?.sessionKey ?? '';
    expect(postNew).toMatch(new RegExp(`^${LANE}:\\d+$`));

    const second = keyedLoop();
    const gw2 = gateway(second.loop, out.adapter, storage, spoolCfg);
    await gw2.restoreLaneSessions(); // what both hosts do before replay
    expect(await gw2.replayInboundSpool()).toMatchObject({ replayed: 1 });
    await waitUntil(() => second.turns.length === 1);
    expect(second.turns[0]?.text).toContain('lost in the crash');
    expect(second.turns[0]?.sessionKey).toBe(postNew);
  });

  it('an unreadable lane file is recorded and the lane starts on its default', async () => {
    const storage = new InMemoryStorage();
    const files = new LaneSessionFiles(storage, DATA_DIR);
    await storage.mkdir(`${DATA_DIR}/gateway/lanes`);
    await storage.write(files.path('bot-a'), '{not json');
    const recordSafetyBlock = vi.fn();
    const out = recordingAdapter();
    const s = keyedLoop();
    const gw = gateway(s.loop, out.adapter, storage, {
      observability: { recordSafetyBlock } as unknown as GatewayConfig['observability'],
    });
    await gw.restoreLaneSessions();
    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'gateway.lane_sessions_unreadable' }),
    );
    await gw.handleMessage(msg('hi'), out.adapter);
    expect(s.turns[0]?.sessionKey).toBe(LANE);
  });

  // U11 — a lane's /mute is stored beside its session key, so it outlives a restart.
  it('/mute survives a restart and leaves the lane on its default session', async () => {
    const storage = new InMemoryStorage();
    const out = recordingAdapter();
    await gateway(keyedLoop().loop, out.adapter, storage).handleMessage(
      msg('/mute 2h'),
      out.adapter,
    );
    const entry = (await new LaneSessionFiles(storage, DATA_DIR).load('bot-a')).get(LANE);
    expect(entry?.sessionKey).toBe(LANE);
    expect(entry?.mutedUntil).toBeGreaterThan(Date.now());

    const held: string[] = [];
    const second = keyedLoop();
    const gw2 = gateway(second.loop, out.adapter, storage, {
      heldNotices: {
        hold: async (n) => {
          held.push(n.text);
        },
        listHeld: async () => [],
        markReleased: async () => {},
      },
    });
    await gw2.restoreLaneSessions();
    await expect(
      gw2.notifyTracked({ platform: 'telegram', chatId: 'chat-1' }, 'job finished'),
    ).resolves.toBe(false);
    expect(held).toEqual(['job finished']);
    await gw2.handleMessage(msg('hi'), out.adapter);
    expect(second.turns[0]?.sessionKey).toBe(LANE);
  });

  it('writes one file per bot under gateway/lanes/', async () => {
    const storage = new InMemoryStorage();
    const out = recordingAdapter();
    await gateway(keyedLoop().loop, out.adapter, storage).handleMessage(msg('/new'), out.adapter);
    const lanes = await new LaneSessionFiles(storage, DATA_DIR).load('bot-a');
    expect([...lanes.keys()]).toEqual([LANE]);
    expect(await storage.list(`${DATA_DIR}/gateway/lanes`)).toEqual(['bot-a.json']);
  });
});

describe('gateway /fork, /branches, /branch', () => {
  it('/fork moves the lane onto a child session, and a restart restores the branch', async () => {
    const storage = new InMemoryStorage();
    const store = await storeWithLaneSession();
    const out = recordingAdapter();
    const first = keyedLoop();
    const gw1 = gateway(first.loop, out.adapter, storage, { sessionStore: () => store });
    await gw1.handleMessage(msg('/fork'), out.adapter);
    expect(out.sends.at(-1)).toMatch(/^✓ Forked/);
    await gw1.handleMessage(msg('on the branch'), out.adapter);
    const forkKey = first.turns[0]?.sessionKey ?? '';
    expect(forkKey).toMatch(new RegExp(`^${LANE}:fork:\\d+-[0-9a-f]{8}$`));

    const root = await store.getSessionByKey(LANE);
    const fork = await store.getSessionByKey(forkKey);
    expect(fork?.parentSessionId).toBe(root?.id);
    expect((await store.getMessages(fork?.id ?? '')).map((m) => m.content)).toEqual([
      'hi',
      'hello',
    ]);

    const second = keyedLoop();
    const gw2 = gateway(second.loop, out.adapter, storage, { sessionStore: () => store });
    await gw2.restoreLaneSessions();
    await gw2.handleMessage(msg('after restart'), out.adapter);
    expect(second.turns[0]?.sessionKey).toBe(forkKey);
  });

  it('/branches lists origin + forks; /branch 1 returns to the origin and persists', async () => {
    const storage = new InMemoryStorage();
    const store = await storeWithLaneSession();
    const out = recordingAdapter();
    const s = keyedLoop();
    const gw = gateway(s.loop, out.adapter, storage, { sessionStore: () => store });
    await gw.handleMessage(msg('/fork'), out.adapter);
    await gw.handleMessage(msg('/branches'), out.adapter);
    const listing = out.sends.at(-1) ?? '';
    expect(listing).toContain(`  1. origin — ${LANE}`);
    expect(listing).toMatch(new RegExp(`\\* 2\\. fork — ${LANE}:fork:\\d+-[0-9a-f]{8}`));

    await gw.handleMessage(msg('/branch 1'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ Switched to branch 1.');
    await gw.handleMessage(msg('back home'), out.adapter);
    expect(s.turns.at(-1)?.sessionKey).toBe(LANE);
    const lanes = await new LaneSessionFiles(storage, DATA_DIR).load('bot-a');
    expect(lanes.get(LANE)?.sessionKey).toBe(LANE);
  });

  it('/branch out of range answers with usage and leaves the lane alone', async () => {
    const storage = new InMemoryStorage();
    const store = await storeWithLaneSession();
    const out = recordingAdapter();
    const s = keyedLoop();
    const gw = gateway(s.loop, out.adapter, storage, { sessionStore: () => store });
    await gw.handleMessage(msg('/branch 7'), out.adapter);
    expect(out.sends.at(-1)).toMatch(/^Usage: \/branch <n>/);
    await gw.handleMessage(msg('still here'), out.adapter);
    expect(s.turns[0]?.sessionKey).toBe(LANE);
    expect(s.turns).toHaveLength(1); // the commands never reached the loop
  });

  it('/fork before any session exists, or with no store wired, is refused politely', async () => {
    const out = recordingAdapter();
    const empty = gateway(keyedLoop().loop, out.adapter, new InMemoryStorage(), {
      sessionStore: () => new InMemorySessionStore(),
    });
    await empty.handleMessage(msg('/fork'), out.adapter);
    expect(out.sends.at(-1)).toMatch(/send a message first/);

    const unwired = gateway(keyedLoop().loop, out.adapter, new InMemoryStorage());
    await unwired.handleMessage(msg('/branches'), out.adapter);
    expect(out.sends.at(-1)).toMatch(/not available/);
  });
});

// Audit G4 (plan openclaw-9.5-adoption item 5): `restoreLaneSessions` runs once
// at boot over the bots configured THEN. A bot added live by the config
// reloader (`addAdapter` → `addBot`) never had its file read, so its lanes ran
// on their defaults and its first `/new` rewrote the file from an empty map.
describe('gateway lane → session map — a bot added live', () => {
  const LANE_B1 = 'telegram:bot-b:chat-1';
  const LANE_B2 = 'telegram:bot-b:chat-2';

  function botBAdapter() {
    const out = recordingAdapter();
    (out.adapter as unknown as { id: string }).id = 'telegram:bot-b';
    return out;
  }

  function msgB(text: string, chatId = 'chat-1'): InboundMessage {
    return { ...msg(text), botKey: 'bot-b', chatId };
  }

  it('restores its lane file before its first turn, and its first /new keeps the other lanes', async () => {
    const storage = new InMemoryStorage();
    const files = new LaneSessionFiles(storage, DATA_DIR);
    // Written by an earlier process that served bot-b.
    await files.save('bot-b', {
      [LANE_B1]: { sessionKey: `${LANE_B1}:fork:1` },
      [LANE_B2]: { sessionKey: `${LANE_B2}:777`, personalityId: 'researcher' },
    });

    const a = recordingAdapter();
    const gw = gateway(keyedLoop().loop, a.adapter, storage);
    await gw.restoreLaneSessions(); // boot: bot-a only

    const b = botBAdapter();
    const loopB = keyedLoop();
    gw.addAdapter(b.adapter, {
      botKey: 'bot-b',
      loop: loopB.loop as unknown as AgentLoop,
      binding: { type: 'personality', name: 'default' },
    });
    // No await between the add and the first message: the gate carries it.
    await gw.handleMessage(msgB('still on my branch?'), b.adapter);
    expect(loopB.turns[0]?.sessionKey).toBe(`${LANE_B1}:fork:1`);

    await gw.handleMessage(msgB('/new'), b.adapter);
    const lanes = await files.load('bot-b');
    expect(lanes.get(LANE_B1)?.sessionKey).toMatch(new RegExp(`^${LANE_B1}:\\d+$`));
    expect(lanes.get(LANE_B2)).toEqual({
      sessionKey: `${LANE_B2}:777`,
      personalityId: 'researcher',
    });
  });

  it('a /new sent before the file has been read cannot overwrite it', async () => {
    const storage = new InMemoryStorage();
    const files = new LaneSessionFiles(storage, DATA_DIR);
    await files.save('bot-b', { [LANE_B2]: { sessionKey: `${LANE_B2}:777` } });

    const a = recordingAdapter();
    const gw = gateway(keyedLoop().loop, a.adapter, storage);
    const b = botBAdapter();
    gw.addAdapter(b.adapter, {
      botKey: 'bot-b',
      loop: keyedLoop().loop as unknown as AgentLoop,
      binding: { type: 'personality', name: 'default' },
    });
    await gw.handleMessage(msgB('/new'), b.adapter);
    expect((await files.load('bot-b')).get(LANE_B2)?.sessionKey).toBe(`${LANE_B2}:777`);
  });
});
