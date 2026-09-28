// plan personality-memory-boundary step 4 — the gateway end to end.
//
// A REAL AgentLoop driven through a REAL Gateway (the `turn-tail.test.ts`
// pattern), with a spy MemoryProvider, a real FsStorage state dir holding a
// canary MEMORY.md, and a scripted LLM that tries `memory_write`, `memory_read`
// and `read_file <state>/personalities/default/MEMORY.md` on every turn and
// writes memory on every turn-end flush it is given. What changes per case is
// only the inbound message, so each case pins one row of `Gateway.audienceFor`
// (and `withholdsPersonalityMemory`, D8):
//
//   group                       → shared: zero personality/user provider calls,
//                                 memory tools absent and refused, file read
//                                 refused, no flush write
//   DM                          → private: unchanged
//   group listed in privateChats→ private, like a DM
//   DM hinted shared (D10)      → shared, still answered
//   non-owner DM (D8)           → personality memory withheld, own USER.md read

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
  privateChatSetFrom,
} from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  DeliveryResult,
  InboundMessage,
  LLMProvider,
  MemoryContext,
  MemoryEntry,
  MemoryProvider,
  Message,
  OutboundMessage,
  PlatformAdapter,
  Tool,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { Gateway } from '../index';

const MEMORY_CANARY = 'canary: interview at ACME';
const USER_CANARY = 'canary-user: prefers terse answers';

type MemCall = { method: 'prefetch' | 'read' | 'search' | 'sync'; scopeId: string };

function spyMemory(): MemoryProvider & { calls: MemCall[] } {
  const calls: MemCall[] = [];
  return {
    calls,
    async prefetch(ctx: MemoryContext) {
      calls.push({ method: 'prefetch', scopeId: ctx.scopeId });
      return { entries: [{ key: 'MEMORY.md', content: MEMORY_CANARY }] };
    },
    async read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
      calls.push({ method: 'read', scopeId: ctx.scopeId });
      return key === 'USER.md' ? { key, content: USER_CANARY } : null;
    },
    async search(_q: string, ctx: MemoryContext) {
      calls.push({ method: 'search', scopeId: ctx.scopeId });
      return [];
    },
    async sync(_updates, ctx: MemoryContext) {
      calls.push({ method: 'sync', scopeId: ctx.scopeId });
    },
    async list() {
      return [];
    },
  };
}

function textOf(m: Message | undefined): string {
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

/**
 * Main turn: first call asks for all three tools, the call after the tool
 * results answers with enough usage to cross the flush gate. Flush call
 * (`silent background memory maintenance`): always writes memory.
 */
function scriptedLLM(memoryPath: string) {
  const mainSystems: string[] = [];
  const mainTools: string[][] = [];
  const flushCalls: number[] = [];
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      tools,
      opts?: { system?: string },
    ): AsyncIterable<CompletionChunk> {
      const system = opts?.system ?? '';
      if (system.includes('silent background memory maintenance')) {
        flushCalls.push(1);
        if (textOf(messages.at(-1)).includes('tool_result')) {
          yield { type: 'done', finishReason: 'end_turn' };
          return;
        }
        const json = '{"store":"memory","action":"add","content":"room secret"}';
        yield { type: 'tool_use_start', toolCallId: 'f1', toolName: 'memory_write' };
        yield { type: 'tool_use_end', toolCallId: 'f1', inputJson: json };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      mainSystems.push(system);
      mainTools.push(tools.map((t) => t.name));
      if (!textOf(messages.at(-1)).includes('tool_result')) {
        const calls: Array<[string, string]> = [
          ['memory_write', '{"store":"memory","action":"add","content":"the deploy is Friday"}'],
          ['memory_read', '{}'],
          ['read_file', JSON.stringify({ path: memoryPath })],
        ];
        for (const [i, [name, json]] of calls.entries()) {
          yield { type: 'tool_use_start', toolCallId: `c${i}`, toolName: name };
          yield { type: 'tool_use_end', toolCallId: `c${i}`, inputJson: json };
        }
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'answered' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 1_000,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, mainSystems, mainTools, flushCalls };
}

function recordingAdapter() {
  const sends: Array<{ chatId: string; text: string }> = [];
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
    send: vi.fn(async (chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push({ chatId, text: m.text });
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

describe('memory boundary through the gateway (plan step 4)', () => {
  let home: string;
  let memoryPath: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-gw-memb-')));
    const own = join(home, 'personalities', 'default');
    await mkdir(own, { recursive: true });
    memoryPath = join(own, 'MEMORY.md');
    await writeFile(memoryPath, MEMORY_CANARY);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function harness() {
    const memory = spyMemory();
    const toolRuns: string[] = [];
    const memoryWrites: unknown[] = [];
    const fileReads: string[] = [];
    const tools = new DefaultToolRegistry();
    const memTool = (name: string): Tool => ({
      name,
      description: name,
      toolset: 'memory',
      capabilities: {},
      schema: { type: 'object', properties: {} },
      async execute(args) {
        toolRuns.push(name);
        if (name === 'memory_write') memoryWrites.push(args);
        return { ok: true, value: name === 'memory_read' ? MEMORY_CANARY : 'ok' };
      },
    });
    tools.register(memTool('memory_write'));
    tools.register(memTool('memory_read'));
    tools.register({
      name: 'read_file',
      description: 'read a file through the turn storage',
      toolset: 'file',
      capabilities: {},
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(args, ctx) {
        const path =
          typeof args === 'object' && args !== null && 'path' in args ? String(args.path) : '';
        try {
          if (!ctx.storage) throw new Error('no storage');
          fileReads.push((await ctx.storage.read(path)) ?? '(missing)');
        } catch (err) {
          fileReads.push(`refused: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { ok: true, value: 'done' };
      },
    });
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({
      id: 'default',
      name: 'Default',
      toolset: ['memory_write', 'memory_read', 'read_file'],
    });
    const scripted = scriptedLLM(memoryPath);
    const loop = new AgentLoop({
      llm: scripted.llm,
      tools,
      memory,
      session: new InMemorySessionStore(),
      personalities,
      storage: new FsStorage(),
      dataDir: home,
      safety: createTestSafety(),
      options: { workingDir: home },
      compaction: { autoCompact: false },
      memoryConsolidation: { enabled: true, flushThreshold: 0.001, minMessagesSinceFlush: 0 },
    });
    const out = recordingAdapter();
    const gw = new Gateway({
      bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
      streamingEditIntervalMs: 0,
      // D9: one listed group.
      privateChats: privateChatSetFrom({ telegram: ['-100listed'] }),
      // D8 needs an owner; the allowlist admits the other senders.
      channelFilter: {
        telegram: {
          ownerUserId: 'owner-1',
          recipientAllowlist: ['stranger-1'],
        },
      },
      // The user scope is only read when the gateway resolves a user id.
      resolveUserId: async (_platform, platformUserId) => `u-${platformUserId}`,
    });
    return { gw, out, memory, toolRuns, memoryWrites, fileReads, scripted };
  }

  function msg(overrides: Partial<InboundMessage>): InboundMessage {
    return {
      platform: 'telegram',
      botKey: 'bot-a',
      chatId: '42',
      userId: 'owner-1',
      text: 'what do you remember about me?',
      isDm: true,
      isGroupMention: false,
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      raw: {},
      ...overrides,
    };
  }

  type H = ReturnType<typeof harness>;

  function expectShared(h: H) {
    const personalityOrUser = h.memory.calls.filter(
      (c) => c.scopeId.startsWith('personality:') || c.scopeId.startsWith('user:'),
    );
    expect(personalityOrUser).toEqual([]);
    for (const tools of h.scripted.mainTools) {
      expect(tools).not.toContain('memory_write');
      expect(tools).not.toContain('memory_read');
    }
    expect(h.toolRuns).toEqual([]);
    expect(h.memoryWrites).toEqual([]);
    expect(h.scripted.flushCalls).toEqual([]);
    expect(h.fileReads).toHaveLength(1);
    expect(h.fileReads[0]).toMatch(/^refused: .*shared-audience memory/);
    expect(h.scripted.mainSystems.join('\n')).not.toContain(MEMORY_CANARY);
    expect(h.scripted.mainSystems.join('\n')).not.toContain(USER_CANARY);
  }

  function expectPrivate(h: H) {
    expect(h.memory.calls).toContainEqual({ method: 'prefetch', scopeId: 'personality:default' });
    expect(h.memory.calls.some((c) => c.method === 'read' && c.scopeId.startsWith('user:'))).toBe(
      true,
    );
    expect(h.scripted.mainTools[0]).toContain('memory_write');
    expect(h.scripted.mainTools[0]).toContain('memory_read');
    expect(h.toolRuns).toEqual(expect.arrayContaining(['memory_write', 'memory_read']));
    expect(h.fileReads).toEqual([MEMORY_CANARY]);
    expect(h.scripted.mainSystems[0]).toContain(MEMORY_CANARY);
    // The turn-end flush ran and wrote.
    expect(h.scripted.flushCalls.length).toBeGreaterThan(0);
  }

  it('a group message is shared: no private memory in, none out, file read refused', async () => {
    const h = harness();
    await h.gw.handleMessage(
      msg({ chatId: '-100group', isDm: false, isGroupMention: true }),
      h.out.adapter,
    );
    expectShared(h);
    // Still answered.
    expect(h.out.sends.map((s) => s.text)).toEqual(['answered']);
  });

  it('an owner DM is unchanged (private)', async () => {
    const h = harness();
    await h.gw.handleMessage(msg({}), h.out.adapter);
    expectPrivate(h);
  });

  it('a group listed in gateway.private_chats behaves like a DM', async () => {
    const h = harness();
    await h.gw.handleMessage(
      msg({ chatId: '-100listed', isDm: false, isGroupMention: true }),
      h.out.adapter,
    );
    expectPrivate(h);
  });

  it('a thread in a listed group inherits the parent chat’s audience', async () => {
    const h = harness();
    await h.gw.handleMessage(
      msg({ chatId: '-100listed', threadId: '7', isDm: false, isGroupMention: true }),
      h.out.adapter,
    );
    expectPrivate(h);
  });

  it('a DM the adapter hinted shared (D10) runs shared but is still answered', async () => {
    const h = harness();
    await h.gw.handleMessage(msg({ audienceHint: 'shared' }), h.out.adapter);
    expectShared(h);
    expect(h.out.sends.map((s) => s.text)).toEqual(['answered']);
  });

  it('a non-owner DM (D8) withholds personality memory but keeps the sender’s own USER.md', async () => {
    const h = harness();
    await h.gw.handleMessage(msg({ chatId: '77', userId: 'stranger-1' }), h.out.adapter);

    expect(h.memory.calls.filter((c) => c.scopeId.startsWith('personality:'))).toEqual([]);
    expect(h.memory.calls).toEqual([{ method: 'read', scopeId: 'user:u-stranger-1' }]);
    expect(h.scripted.mainSystems[0]).toContain(USER_CANARY);
    expect(h.scripted.mainSystems[0]).not.toContain(MEMORY_CANARY);
    expect(h.scripted.mainTools[0]).not.toContain('memory_write');
    expect(h.scripted.mainTools[0]).not.toContain('memory_read');
    expect(h.toolRuns).toEqual([]);
    expect(h.scripted.flushCalls).toEqual([]);
    expect(h.fileReads[0]).toMatch(/^refused: .*shared-audience memory/);
  });
});
