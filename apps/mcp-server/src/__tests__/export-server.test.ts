// M-T5 — `PersonalityExportServer`, the default-deny per-personality MCP export
// (Part 3 of plan/phases/trust-before-reach.md).
//
// Every test here drives the REAL class over the SDK's in-memory transport with
// a stub loop, so what is asserted is what an external client would actually
// get: the JSON-RPC handlers, the per-call gate, and the run options the turn
// is pinned to.

import type { AgentEvent, AgentLoop, RunOptions } from '@ethosagent/core';
import type { PersonalityConfig, Session, SessionStore, StoredMessage } from '@ethosagent/types';
import { resolveMcpExportScope } from '@ethosagent/wiring';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  type McpExportAuditEntry,
  PersonalityExportServer,
  type PersonalityExportServerConfig,
} from '../export-server';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Everything registered on the machine — more than the personality can reach. */
const REGISTERED = [
  'read_file',
  'web_search',
  'terminal',
  'memory_read',
  'memory_write',
  'mcp__x__y',
];

const registry = {
  getAvailable: () => REGISTERED.map((name) => ({ name })),
  toolNamesForPersonality: (p: PersonalityConfig) => new Set(p.toolset ?? []),
};

function reviewer(over: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews project material against approved sources.',
    toolset: ['read_file', 'web_search', 'memory_read', 'memory_write'],
    mcp_export: { enabled: true, expose_tools: ['read_file'] },
    ...over,
  } as PersonalityConfig;
}

interface Harness {
  server: PersonalityExportServer;
  client: Client;
  runs: Array<{ prompt: string; options: RunOptions | undefined }>;
  audit: McpExportAuditEntry[];
  refreshes: { count: number };
  /** Swap the live personality — the next call must see the new one. */
  setPersonality(next: PersonalityConfig | undefined): void;
  close(): Promise<void>;
}

async function harness(
  opts: {
    personality?: PersonalityConfig;
    events?: () => AgentEvent[];
    sessionStore?: SessionStore;
    clientName?: string;
    config?: Partial<PersonalityExportServerConfig>;
  } = {},
): Promise<Harness> {
  let live: PersonalityConfig | undefined = opts.personality ?? reviewer();
  const runs: Array<{ prompt: string; options: RunOptions | undefined }> = [];
  const audit: McpExportAuditEntry[] = [];
  const refreshes = { count: 0 };

  const events = opts.events ?? (() => [{ type: 'done' as const, text: 'hello', turnCount: 1 }]);
  const loop = {
    run: (prompt: string, options?: RunOptions): AsyncGenerator<AgentEvent> => {
      runs.push({ prompt, options });
      return (async function* () {
        for (const event of events()) yield event;
      })();
    },
  } as unknown as AgentLoop;

  const server = new PersonalityExportServer({
    personalityId: 'reviewer',
    loop,
    personalities: { get: (id) => (id === 'reviewer' ? live : undefined) },
    refreshPersonalities: async () => {
      refreshes.count += 1;
    },
    toolRegistry: registry,
    resolveScope: resolveMcpExportScope,
    logger: noopLogger,
    audit: { record: (e) => audit.push(e) },
    ...(opts.sessionStore ? { sessionStore: opts.sessionStore } : {}),
    ...opts.config,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: opts.clientName ?? 'probe', version: '1' });
  await client.connect(clientTransport);

  return {
    server,
    client,
    runs,
    audit,
    refreshes,
    setPersonality: (next) => {
      live = next;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolCallResult = { isError?: boolean; content: Array<{ text: string }> };

const callAsk = (client: Client, args: Record<string, unknown>): Promise<ToolCallResult> =>
  client.callTool({ name: 'ask', arguments: args }) as Promise<ToolCallResult>;

// ---------------------------------------------------------------------------

describe('PersonalityExportServer discovery', () => {
  it('lists exactly one tool, `ask`, when sessions are off', async () => {
    const h = await harness();
    const tools = await h.client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['ask']);
    // The client can never name the personality, the key, or the tool set.
    expect(Object.keys(tools.tools[0]?.inputSchema.properties ?? {}).sort()).toEqual([
      'conversation',
      'prompt',
    ]);
    await h.close();
  });

  it('describes `ask` with the personality description and names the server ethos-<id>', async () => {
    const h = await harness();
    const tools = await h.client.listTools();
    expect(tools.tools[0]?.description).toBe('Reviews project material against approved sources.');
    expect(h.client.getServerVersion()?.name).toBe('ethos-reviewer');
    expect(h.client.getInstructions()).toContain('Reviewer');
    await h.close();
  });

  it('offers no resources and no prompts', async () => {
    const h = await harness();
    expect(h.client.getServerCapabilities()).toEqual({ tools: {} });
    await h.close();
  });

  it('adds the conversation tools only when expose_sessions is true', async () => {
    const store = fakeSessionStore([]);
    const off = await harness({ sessionStore: store });
    expect((await off.client.listTools()).tools.map((t) => t.name)).toEqual(['ask']);
    await off.close();

    const on = await harness({
      sessionStore: store,
      personality: reviewer({
        mcp_export: { enabled: true, expose_tools: ['read_file'], expose_sessions: true },
      }),
    });
    expect((await on.client.listTools()).tools.map((t) => t.name)).toEqual([
      'ask',
      'list_conversations',
      'get_conversation',
    ]);
    await on.close();
  });

  it('publishes nothing once the export is withdrawn', async () => {
    const h = await harness();
    expect((await h.client.listTools()).tools).toHaveLength(1);
    h.setPersonality(reviewer({ mcp_export: { enabled: false } }));
    expect((await h.client.listTools()).tools).toEqual([]);
    expect(h.audit.at(-1)).toMatchObject({
      kind: 'discovery',
      decision: 'denied',
      reason: 'export_disabled',
    });
    await h.close();
  });
});

describe('PersonalityExportServer ask', () => {
  it('pins every run option the client could otherwise name', async () => {
    const h = await harness();
    const result = await callAsk(h.client, { prompt: 'review this' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('hello');

    expect(h.runs).toHaveLength(1);
    const run = h.runs[0];
    expect(run?.prompt).toBe('review this');
    // Personality: pinned by the server, absent from the schema (M-D12).
    expect(run?.options?.personalityId).toBe('reviewer');
    // Session key: built by the server, `mcp:<id>:<clientId>:<conversation>` (M-D8).
    expect(run?.options?.sessionKey).toMatch(/^mcp:reviewer:stdio-probe:[A-Za-z0-9_-]{1,64}$/);
    // Narrow: the declaration ∩ the personality's reach.
    expect(run?.options?.toolsetNarrow).toEqual(['read_file']);
    // Exclude: the complement, which is the half that also reaches `mcp__*`.
    expect(run?.options?.toolsetExclude).toEqual(
      expect.arrayContaining([
        'web_search',
        'terminal',
        'memory_read',
        'memory_write',
        'mcp__x__y',
      ]),
    );
    expect(run?.options?.toolsetExclude).not.toContain('read_file');
    // `expose_memory` defaults to none → no prefetch (M-D5).
    expect(run?.options?.skipMemoryPrefetch).toBe(true);
    await h.close();
  });

  it('leaves the prefetch alone when expose_memory is scoped', async () => {
    const h = await harness({
      personality: reviewer({
        mcp_export: { enabled: true, expose_tools: 'all', expose_memory: 'scoped' },
      }),
    });
    await callAsk(h.client, { prompt: 'hi' });
    expect(h.runs[0]?.options?.skipMemoryPrefetch).toBeUndefined();
    // `scoped` is read-only: memory_write is stripped even though it is in reach.
    expect(h.runs[0]?.options?.toolsetNarrow).toEqual(['memory_read', 'read_file', 'web_search']);
    await h.close();
  });

  it('returns the conversation id and reuses the same session key when it is passed back', async () => {
    const h = await harness();
    const first = await callAsk(h.client, { prompt: 'one' });
    const { conversation } = JSON.parse(first.content.at(-1)?.text ?? '{}') as {
      conversation: string;
    };
    expect(conversation).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    await callAsk(h.client, { prompt: 'two', conversation });
    expect(h.runs[1]?.options?.sessionKey).toBe(`mcp:reviewer:stdio-probe:${conversation}`);
    expect(h.runs[0]?.options?.sessionKey).toBe(h.runs[1]?.options?.sessionKey);
    await h.close();
  });

  it('refuses a conversation that tries to escape its own prefix', async () => {
    const h = await harness();
    const result = await callAsk(h.client, { prompt: 'hi', conversation: 'cli:ethos' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('input_invalid');
    expect(h.runs).toHaveLength(0);
    await h.close();
  });

  it('refuses a conversation that is too long', async () => {
    const h = await harness();
    const result = await callAsk(h.client, { prompt: 'hi', conversation: 'a'.repeat(65) });
    expect(result.isError).toBe(true);
    expect(h.runs).toHaveLength(0);
    await h.close();
  });

  it('turns an `error` event into an isError result carrying the code', async () => {
    const h = await harness({
      events: () => [
        { type: 'error', error: 'turn budget exhausted', code: 'BUDGET_EXCEEDED' },
        { type: 'done', text: '', turnCount: 1 },
      ],
    });
    const result = await callAsk(h.client, { prompt: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('BUDGET_EXCEEDED');
    expect(h.audit.at(-1)).toMatchObject({
      kind: 'call',
      decision: 'denied',
      reason: 'BUDGET_EXCEEDED',
    });
    await h.close();
  });

  it('turns a `halt` event into an isError result and keeps the partial text', async () => {
    const h = await harness({
      events: () => [
        { type: 'text_delta', text: 'partial' },
        {
          type: 'halt',
          kind: 'watcher',
          rule: 'rm -rf',
          message: 'stopped by the safety watcher',
        },
        { type: 'done', text: 'partial', turnCount: 1 },
      ],
    });
    const result = await callAsk(h.client, { prompt: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HALT_WATCHER');
    expect(result.content[1]?.text).toBe('partial');
    await h.close();
  });

  it('refuses an export disabled mid-process on the very next call', async () => {
    const h = await harness();
    expect((await callAsk(h.client, { prompt: 'one' })).isError).toBeFalsy();

    h.setPersonality(reviewer({ mcp_export: { enabled: false, expose_tools: ['read_file'] } }));

    const refused = await callAsk(h.client, { prompt: 'two' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('export_disabled');
    // The refusal happened BEFORE the turn — nothing was billed.
    expect(h.runs).toHaveLength(1);
    await h.close();
  });

  it('refuses once the personality is gone entirely', async () => {
    const h = await harness();
    h.setPersonality(undefined);
    const refused = await callAsk(h.client, { prompt: 'hi' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('unknown_personality');
    await h.close();
  });

  it('re-reads the personality registry before every call', async () => {
    const h = await harness();
    const before = h.refreshes.count;
    await callAsk(h.client, { prompt: 'one' });
    await callAsk(h.client, { prompt: 'two' });
    expect(h.refreshes.count).toBeGreaterThanOrEqual(before + 2);
    await h.close();
  });

  it('allows at most one ask in flight per client', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loopRuns: string[] = [];
    const loop = {
      run: (prompt: string): AsyncGenerator<AgentEvent> => {
        loopRuns.push(prompt);
        return (async function* () {
          await gate;
          yield { type: 'done' as const, text: 'done', turnCount: 1 };
        })();
      },
    } as unknown as AgentLoop;

    const server = new PersonalityExportServer({
      personalityId: 'reviewer',
      loop,
      personalities: { get: () => reviewer() },
      refreshPersonalities: async () => {},
      toolRegistry: registry,
      resolveScope: resolveMcpExportScope,
      logger: noopLogger,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'probe', version: '1' });
    await client.connect(ct);

    const first = callAsk(client, { prompt: 'slow' });
    // Let the first call reach `loop.run` before the second arrives.
    await waitFor(() => loopRuns.length === 1);
    const second = await callAsk(client, { prompt: 'racing' });
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toContain('busy');
    expect(loopRuns).toEqual(['slow']);

    release?.();
    expect((await first).isError).toBeFalsy();
    // The slot is released afterwards.
    expect((await callAsk(client, { prompt: 'after' })).isError).toBeFalsy();

    await client.close();
    await server.close();
  });

  it('records metadata only — no prompt, no answer, no key', async () => {
    const h = await harness();
    await callAsk(h.client, { prompt: 'a secret question' });
    const serialized = JSON.stringify(h.audit);
    expect(serialized).not.toContain('a secret question');
    expect(serialized).not.toContain('hello');
    expect(h.audit.some((e) => e.kind === 'call' && e.decision === 'accepted')).toBe(true);
    expect(h.audit.every((e) => e.personalityId === 'reviewer')).toBe(true);
    await h.close();
  });

  it('carries the turn trace id into the call audit entry', async () => {
    const h = await harness({
      events: () => [
        {
          type: 'run_start',
          provider: 'anthropic',
          model: 'm',
          source: 'personality',
          traceId: 'trace-7',
        },
        { type: 'done', text: 'hello', turnCount: 1 },
      ],
    });
    await callAsk(h.client, { prompt: 'hi' });
    expect(h.audit.find((e) => e.kind === 'call')?.traceId).toBe('trace-7');
    await h.close();
  });
});

// ---------------------------------------------------------------------------
// Conversation tools (M-D7)
// ---------------------------------------------------------------------------

function fakeSessionStore(sessions: Array<Pick<Session, 'id' | 'key' | 'title'>>): SessionStore & {
  filters: Array<{ keyPrefix?: string }>;
} {
  const rows = sessions.map((s) => ({ ...s, updatedAt: new Date(0) }));
  const filters: Array<{ keyPrefix?: string }> = [];
  return {
    filters,
    listSessions: async (filter?: { keyPrefix?: string; limit?: number }) => {
      filters.push({ ...(filter?.keyPrefix ? { keyPrefix: filter.keyPrefix } : {}) });
      const prefix = filter?.keyPrefix;
      return rows.filter((r) => !prefix || r.key.startsWith(prefix)) as unknown as Session[];
    },
    getSessionByKey: async (key: string) =>
      (rows.find((r) => r.key === key) as unknown as Session) ?? null,
    getMessages: async () =>
      [
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: 'earlier question',
          timestamp: new Date(0),
        },
      ] as unknown as StoredMessage[],
  } as unknown as SessionStore & { filters: Array<{ keyPrefix?: string }> };
}

describe('PersonalityExportServer conversation tools', () => {
  const exposed = reviewer({
    mcp_export: { enabled: true, expose_tools: ['read_file'], expose_sessions: true },
  });

  const seeded = () =>
    fakeSessionStore([
      { id: 's1', key: 'mcp:reviewer:stdio-probe:mine', title: 'mine' },
      { id: 's2', key: 'mcp:reviewer:stdio-other:theirs', title: 'another client' },
      { id: 's3', key: 'mcp-console:reviewer:operator', title: 'the operator console' },
      { id: 's4', key: 'cli:ethos', title: 'the operator terminal' },
    ]);

  it('lists only this client’s own conversations with this personality', async () => {
    const store = seeded();
    const h = await harness({ personality: exposed, sessionStore: store });
    const result = (await h.client.callTool({
      name: 'list_conversations',
      arguments: {},
    })) as ToolCallResult;
    const rows = JSON.parse(result.content[0]?.text ?? '[]') as Array<{ conversation: string }>;
    expect(rows.map((r) => r.conversation)).toEqual(['mine']);
    // The filter is the whole guarantee — assert the prefix it was given.
    expect(store.filters.at(-1)?.keyPrefix).toBe('mcp:reviewer:stdio-probe:');
    await h.close();
  });

  it('cannot read another client’s conversation by naming it', async () => {
    const h = await harness({ personality: exposed, sessionStore: seeded() });
    const mine = (await h.client.callTool({
      name: 'get_conversation',
      arguments: { conversation: 'mine' },
    })) as ToolCallResult;
    expect(mine.isError).toBeFalsy();
    expect(mine.content[0]?.text).toContain('earlier question');

    const theirs = (await h.client.callTool({
      name: 'get_conversation',
      arguments: { conversation: 'theirs' },
    })) as ToolCallResult;
    expect(theirs.isError).toBe(true);
    expect(theirs.content[0]?.text).toContain('not_found');
    await h.close();
  });

  it('refuses a conversation argument that is not a bare label', async () => {
    const h = await harness({ personality: exposed, sessionStore: seeded() });
    const escaped = (await h.client.callTool({
      name: 'get_conversation',
      arguments: { conversation: 'mcp-console:reviewer:operator' },
    })) as ToolCallResult;
    expect(escaped.isError).toBe(true);
    expect(escaped.content[0]?.text).toContain('input_invalid');
    await h.close();
  });

  it('refuses the conversation tools when expose_sessions is off', async () => {
    const h = await harness({ sessionStore: seeded() });
    const result = (await h.client.callTool({
      name: 'list_conversations',
      arguments: {},
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('unknown_tool');
    await h.close();
  });
});

// ---------------------------------------------------------------------------
// Bearer over stdio (ETHOS_MCP_KEY)
// ---------------------------------------------------------------------------

describe('PersonalityExportServer bearer over stdio', () => {
  const bearer = reviewer({
    mcp_export: { enabled: true, expose_tools: ['read_file'], auth: 'bearer' },
  });

  const authenticator = (accept: () => boolean) => ({
    requiredScope: 'mcp:reviewer',
    verify: async (secret: string | undefined) =>
      secret === 'sk-ethos-good' && accept()
        ? {
            ok: true as const,
            clientId: 'key-sk-ethos-abcd1234',
            keyId: 'k1',
            keyPrefix: 'sk-ethos-abcd1234',
            keyName: 'claude-desktop',
          }
        : { ok: false as const, reason: 'invalid_key' as const },
  });

  it('keys the session on the key prefix, not the client name', async () => {
    const h = await harness({
      personality: bearer,
      config: { authenticator: authenticator(() => true), stdioSecret: 'sk-ethos-good' },
    });
    await callAsk(h.client, { prompt: 'hi' });
    expect(h.runs[0]?.options?.sessionKey).toMatch(
      /^mcp:reviewer:key-sk-ethos-abcd1234:[A-Za-z0-9_-]+$/,
    );
    await h.close();
  });

  it('refuses when the key is revoked mid-process', async () => {
    let live = true;
    const h = await harness({
      personality: bearer,
      config: { authenticator: authenticator(() => live), stdioSecret: 'sk-ethos-good' },
    });
    expect((await callAsk(h.client, { prompt: 'one' })).isError).toBeFalsy();
    live = false;
    const refused = await callAsk(h.client, { prompt: 'two' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('invalid_key');
    expect(h.runs).toHaveLength(1);
    await h.close();
  });

  it('refuses when no key was presented at all', async () => {
    const h = await harness({
      personality: bearer,
      config: { authenticator: authenticator(() => true) },
    });
    const refused = await callAsk(h.client, { prompt: 'hi' });
    expect(refused.isError).toBe(true);
    expect(h.runs).toHaveLength(0);
    await h.close();
  });
});

// Small poll helper — the SDK gives no hook for "the request reached the handler".
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
