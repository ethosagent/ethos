// Per-room prompt wiring (plan channel-prompts L3b, L5, D8); shared setup in room-policy-gateway.fixtures.ts.

import { buildLaneKey, DefaultSttProviderRegistry } from '@ethosagent/core';
import type {
  AttachmentCache,
  Session,
  SessionStore,
  Storage,
  SttProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { RoomPolicyTable } from '../room-policy';
import { adapterFor, gateway, loopStub, msg } from './room-policy-gateway.fixtures';

describe('voice note in a room', () => {
  it('a transcribed voice note gets the room block', async () => {
    const provider: SttProvider = {
      name: 'local-stt',
      caps: { kind: 'stt', formats: ['opus'], local: true, contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async () => 'book a table',
    };
    const registry = new DefaultSttProviderRegistry();
    registry.register('local-stt', () => provider);
    const attachmentCache: AttachmentCache = {
      write: async () => 'file:///cache/note.ogg',
      clear: async () => {},
      pruneOlderThan: async () => ({ removedCount: 0 }),
      resolveLocalPath: (url) => url.replace('file://', ''),
    };
    const storage = { readBytes: async () => Uint8Array.from([1, 2, 3]) } as unknown as Storage;
    const s = loopStub();
    const gw = gateway(
      s.loop,
      { telegram: { entries: { C1: { prompt: 'voice room' } } } },
      {
        attachmentCache,
        storage,
        sttProviderRegistry: registry,
        sttProviderName: 'local-stt',
      },
    );
    await gw.handleMessage(
      msg('telegram', {
        text: '',
        attachments: [
          { type: 'audio', ref: 'a1', url: 'file:///cache/note.ogg', mimeType: 'audio/ogg' },
        ],
      }),
      adapterFor('telegram'),
    );
    expect(s.calls[0]?.voiceOrigin).toBeDefined();
    expect(s.calls[0]?.roomPrompt).toBe('voice room');
  });
});

describe('D8 — gateway.room_policy_changed', () => {
  function sessionStoreFake() {
    const rows = new Map<string, Session>();
    const store = {
      getSessionByKey: async (key: string) => rows.get(key) ?? null,
      updateSession: async (id: string, patch: Partial<Session>) => {
        for (const row of rows.values()) if (row.id === id) Object.assign(row, patch);
      },
    } as unknown as SessionStore;
    return { store, rows };
  }

  async function turn(
    table: RoomPolicyTable,
    store: SessionStore,
    events: Array<Record<string, unknown>>,
  ) {
    const s = loopStub();
    const gw = gateway(s.loop, table, {
      sessionStore: () => store,
      observability: {
        recordSafetyBlock: (e: { code?: string; details?: Record<string, unknown> }) => {
          events.push({ code: e.code, ...e.details });
        },
      } as never,
    });
    await gw.handleMessage(msg('slack', { chatId: 'C1' }), adapterFor('slack'));
  }

  const changed = (events: Array<Record<string, unknown>>) =>
    events.filter((e) => e.code === 'gateway.room_policy_changed');

  it('stores the digest, stays quiet when unchanged, emits once when the prompt changes', async () => {
    const { store, rows } = sessionStoreFake();
    const key = buildLaneKey('slack', 'bot-a', 'C1');
    rows.set(key, { id: 'sess-1', key, metadata: { keep: 1 } } as unknown as Session);
    const events: Array<Record<string, unknown>> = [];
    const v1: RoomPolicyTable = { slack: { entries: { C1: { prompt: 'v1' } } } };

    await turn(v1, store, events);
    expect(rows.get(key)?.metadata).toMatchObject({
      keep: 1,
      roomPolicyDigest: expect.any(String),
      roomPolicyIsDm: false,
    });
    expect(changed(events)).toHaveLength(0);

    await turn(v1, store, events); // a restart with the same config
    expect(changed(events)).toHaveLength(0);

    await turn({ slack: { entries: { C1: { prompt: 'v2' } } } }, store, events);
    expect(changed(events)).toHaveLength(1);
    await turn({ slack: { entries: { C1: { prompt: 'v2' } } } }, store, events);
    expect(changed(events)).toHaveLength(1);
    expect(rows.get(key)?.metadata).toMatchObject({ keep: 1 });
  });
});

describe('whole-block cap and unconfigured deployments', () => {
  it('records gateway.room_prompt_trimmed once per lane and still runs the turn', async () => {
    const events: Array<Record<string, unknown>> = [];
    const s = loopStub();
    const gw = gateway(
      s.loop,
      {
        discord: {
          entries: {
            P: { prompt: 'p'.repeat(3000) },
            'P.topics.T': { prompt: 't'.repeat(3000) },
            T: { prompt: 'd'.repeat(3000) },
          },
        },
      },
      {
        observability: {
          recordSafetyBlock: (e: { code?: string; details?: Record<string, unknown> }) => {
            events.push({ code: e.code, ...e.details });
          },
        } as never,
      },
    );
    const a = adapterFor('discord');
    await gw.handleMessage(msg('discord', { chatId: 'P', threadId: 'T' }), a);
    await gw.handleMessage(msg('discord', { chatId: 'P', threadId: 'T' }), a);
    const trimmed = events.filter((e) => e.code === 'gateway.room_prompt_trimmed');
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.dropped).toEqual(['T']);
    expect(String(s.calls[0]?.roomPrompt)).toHaveLength(6002);
  });

  it('a platform with no table entry does no session read for room policy', async () => {
    const getSessionByKey = vi.fn(async () => null);
    const store = { getSessionByKey, updateSession: vi.fn() } as unknown as SessionStore;
    const s = loopStub();
    const gw = gateway(
      s.loop,
      { slack: { entries: { '*': { prompt: 'x' } } } },
      {
        sessionStore: () => store,
      },
    );
    await gw.handleMessage(msg('telegram'), adapterFor('telegram'));
    expect(getSessionByKey).not.toHaveBeenCalled();
  });
});
