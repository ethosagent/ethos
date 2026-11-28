// Task 6.5: the morning digest step of the scheduled tick. The LLM is scripted (no network); `notify`
// stands in for `Gateway.notifyTracked`, whose quiet-hours hold is pinned by
// extensions/gateway/src/__tests__/notify-tracked.test.ts (U11).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPersonalityRegistry } from '@ethosagent/core';
import { InitiativeConfigService } from '@ethosagent/initiative-runner';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createInitiativeRuntime, type DigestNotify } from '../initiative-runtime';
import { createLazyInitiativeStore } from '../initiatives';

const EARLY = new Date('2026-11-28T08:00:00Z');
const DUE = new Date('2026-11-28T09:30:00Z');
const LATER = new Date('2026-11-28T15:00:00Z');
const NEXT_DAY = new Date('2026-11-29T09:30:00Z');

const llm: LLMProvider = {
  name: 'scripted',
  model: 'mock-model',
  maxContextTokens: 200_000,
  supportsCaching: false,
  supportsThinking: false,
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'text_delta', text: 'Nothing yet.' };
    yield { type: 'done', finishReason: 'end_turn' };
  },
  async countTokens() {
    return 1;
  },
};

let home: string;
let dataDir: string;
const closers: Array<{ close(): void }> = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-initiative-digest-'));
  dataDir = join(home, '.ethos');
  for (const id of ['product-manager', 'writer']) {
    mkdirSync(join(dataDir, 'personalities', id, 'initiatives'), { recursive: true });
  }
});

afterEach(() => {
  while (closers.length) closers.pop()?.close();
  rmSync(home, { recursive: true, force: true });
});

const writeDelivery = (id: string, channel: string) =>
  writeFileSync(
    join(dataDir, 'personalities', id, 'initiatives', 'settings.yaml'),
    `delivery:\n  ownerChannel: "${channel}"\n  digestTime: "09:00"\n`,
  );

async function setup(notify: DigestNotify | undefined, storage: Storage = new FsStorage()) {
  const ledger = createLazyInitiativeStore({ storage, dataDir });
  closers.push(ledger);
  const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
  closers.push(session as unknown as { close(): void });
  const personalities = new DefaultPersonalityRegistry();
  for (const id of ['product-manager', 'writer']) {
    personalities.define({ id, name: id, toolset: ['web_search'] });
  }
  const warnings: string[] = [];
  const runtime = createInitiativeRuntime({
    storage,
    dataDir,
    ledger,
    personalities,
    llm,
    safety: createTestSafety(),
    config: {},
    toolsConfig: () => undefined,
    memory: new MarkdownFileMemoryProvider({ dir: dataDir, storage }),
    session,
    clock: () => DUE,
    log: { warn: (m) => warnings.push(m) },
    ...(notify ? { notify } : {}),
  });
  const config = new InitiativeConfigService({
    storage,
    dataDir,
    store: ledger.store,
    constitution: async () => ({}),
    settings: async () => ({
      enabled: true,
      selfStart: false,
      dailyBudgetUsd: 0,
      standingGuidance: [],
    }),
    toolset: () => ['web_search'],
    schedule: () => {},
  });
  const save = async (personalityId: string, id: string) => {
    const r = await config.save({
      personalityId,
      op: 'create',
      sessionId: 'chat-1',
      confirmedBy: 'owner_chat',
      draft: {
        id,
        version: 1,
        origin: 'human',
        created_in: 'chat',
        state: 'active',
        title: id,
        outcome: 'learn something',
        sources: ['web'],
        exclude: [],
        guidance: [],
        autonomy: { mode: 'ask' },
        budget: { usd_per_day: 0.01, usd_per_exploration: 1, max_open_explorations: 3 },
        timeline: {
          explore_windows: ['every 6h'],
          window_minutes: 20,
          default_days: 7,
          review_on: '2026-12-20',
        },
        delivery: { owner_channel: 'slack:CMODEL', digest_time: '09:00' },
      },
    });
    expect(r).toMatchObject({ ok: true });
    ledger.store.propose({
      initiativeId: id,
      ideaId: null,
      question: `question for ${id}`,
      estimateUsd: 0.5,
      days: 3,
    });
  };
  return { runtime, save, warnings };
}

describe('initiative digest', () => {
  it('digest goes to owner channel only, once per day', async () => {
    const sent: Array<{ target: unknown; text: string }> = [];
    const { runtime, save } = await setup(async (target, text) => {
      sent.push({ target, text });
      return true;
    });
    await save('product-manager', 'activation');
    await save('writer', 'launch-posts');
    writeDelivery('product-manager', 'telegram:42');
    // writer has no delivery in settings: it gets no digest, whatever its initiative file says.

    await runtime.tick(EARLY);
    expect(sent).toEqual([]);

    const first = await runtime.tick(DUE);
    expect(first.digests).toEqual(['product-manager']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({ platform: 'telegram', chatId: '42' });
    expect(sent[0]?.text).toContain('question for activation');
    expect(sent[0]?.text).not.toContain('launch-posts');

    await runtime.tick(LATER);
    expect(sent).toHaveLength(1);

    await runtime.tick(NEXT_DAY);
    expect(sent).toHaveLength(2);
  });

  it('hands the composed digest to notify beside the text, for the button card', async () => {
    const seen: Array<{ personalityId: string; needsYes: number } | undefined> = [];
    const { runtime, save } = await setup(async (_target, _text, digest) => {
      seen.push(
        digest && { personalityId: digest.personalityId, needsYes: digest.needsYes.length },
      );
      return true;
    });
    await save('product-manager', 'activation');
    writeDelivery('product-manager', 'telegram:42');
    await runtime.tick(DUE);
    expect(seen).toEqual([{ personalityId: 'product-manager', needsYes: 1 }]);
  });

  it('quiet hours hold delivery', async () => {
    let calls = 0;
    const { runtime, save } = await setup(async () => {
      calls++;
      return 'held'; // Gateway.notifyTracked inside quiet hours: owed, released by the gateway
    });
    await save('product-manager', 'activation');
    writeDelivery('product-manager', 'telegram:42');
    const first = await runtime.tick(DUE);
    expect(first.digests).toEqual(['product-manager']);
    await runtime.tick(LATER);
    expect(calls).toBe(1); // the gateway owns the release; the tick does not resend
  });

  it('a refused send is retried at the next tick', async () => {
    let calls = 0;
    const { runtime, save, warnings } = await setup(async () => ++calls > 1);
    await save('product-manager', 'activation');
    writeDelivery('product-manager', 'telegram:42');
    expect((await runtime.tick(DUE)).digests).toEqual([]);
    expect(warnings.join('\n')).toContain('not delivered');
    expect((await runtime.tick(LATER)).digests).toEqual(['product-manager']);
  });

  it('a notify that throws restores the marker, so the next tick retries', async () => {
    let calls = 0;
    const { runtime, save, warnings } = await setup(async () => {
      if (++calls === 1) throw new Error('network down');
      return true;
    });
    await save('product-manager', 'activation');
    writeDelivery('product-manager', 'telegram:42');
    expect((await runtime.tick(DUE)).digests).toEqual([]);
    expect(warnings.join('\n')).toContain('network down');
    expect((await runtime.tick(LATER)).digests).toEqual(['product-manager']);
    expect(calls).toBe(2);
  });

  it('an owner channel with no chat id sends nothing', async () => {
    let calls = 0;
    const { runtime, save } = await setup(async () => {
      calls++;
      return true;
    });
    await save('product-manager', 'activation');
    writeDelivery('product-manager', 'telegram');
    await runtime.tick(DUE);
    expect(calls).toBe(0);
  });

  it('a marker that cannot be written sends nothing, so a broken store cannot resend every tick', async () => {
    let calls = 0;
    const real = new FsStorage();
    const failing = Object.create(real) as Storage;
    failing.writeAtomic = async (path, data) => {
      if (path.endsWith('.digest-sent.json')) throw new Error('disk full');
      return real.writeAtomic(path, data);
    };
    const { runtime, save } = await setup(async () => {
      calls++;
      return true;
    }, failing);
    await save('product-manager', 'activation');
    writeDelivery('product-manager', 'telegram:42');
    await runtime.tick(DUE);
    await runtime.tick(LATER);
    expect(calls).toBe(0);
  });

  it('notify can be bound after the runtime is built', async () => {
    const calls: string[] = [];
    const { runtime, save } = await setup(undefined);
    await save('product-manager', 'activation');
    writeDelivery('product-manager', 'telegram:42');
    expect((await runtime.tick(DUE)).digests).toEqual([]); // no sender yet: marker not written either
    runtime.setNotify(async (_t, text) => {
      calls.push(text);
      return true;
    });
    expect((await runtime.tick(LATER)).digests).toEqual(['product-manager']);
    expect(calls).toHaveLength(1);
  });
});
