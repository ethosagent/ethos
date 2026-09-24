import { DefaultToolRegistry } from '@ethosagent/core';
import { createMemoryReadTool, createMemoryWriteTool } from '@ethosagent/tools-memory';
import type {
  HookRegistry,
  MemoryContext,
  MemoryProvider,
  MemoryUpdate,
  PersonalityConfig,
  RedactionKit,
  Tool,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AGENT_CONSULT_TOOL, deriveRealtimeToolset } from '../agent-consult';
import { createRealtimeToolHost, REALTIME_UNKNOWN_TOOL } from '../realtime-host';

// Tools with no loop behind them — this file is about advertising and dispatch,
// not about what a consult returns.
function echoTool(name: string, value: string, toolset = 'voice'): Tool {
  return {
    name,
    description: `echo ${name}`,
    toolset,
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, value };
    },
  };
}

function registryWith(...tools: Tool[]): DefaultToolRegistry {
  const registry = new DefaultToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

// A stand-in for the loop's redaction kit: one known string is "a secret".
const SECRET = 'sk-test-SECRET-value';
const testRedaction: RedactionKit = {
  redactPii: (s) => s,
  redactString: (s) => s.split(SECRET).join('[REDACTED:test]'),
  detectSecrets: (s) => (s.includes(SECRET) ? [{ label: 'test secret' }] : []),
};
const base = { personality: undefined, resultRedaction: { redaction: testRedaction } };

const dispatchCtx = {
  sessionId: 'row-1',
  sessionKey: 'voice:web:browser:chat-9',
  platform: 'web',
  workingDir: '/tmp',
  abortSignal: new AbortController().signal,
  voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' as const },
};

describe('advertised == handled', () => {
  it('every advertised tool dispatches — none answers "unknown tool"', async () => {
    // The real assertion. Comparing two name lists would only prove that one
    // `map()` matches another; what a listener actually depends on is that
    // asking for an advertised tool produces a serviced answer. So this drives
    // each advertised definition through `dispatch` and refuses the refusal.
    const registry = registryWith(
      echoTool(AGENT_CONSULT_TOOL, 'consulted'),
      echoTool('read_file', 'file contents', 'file'),
      echoTool('send_email', 'sent', 'email'),
    );
    const host = createRealtimeToolHost({
      ...base,
      registry,
      personalityToolset: ['read_file', 'send_email'],
      safeTools: new Set(['read_file']),
    });

    expect(host.definitions.length).toBeGreaterThan(0);
    expect(host.handled).toEqual(host.definitions.map((d) => d.name));

    for (const definition of host.definitions) {
      const result = await host.dispatch(
        { callId: `c-${definition.name}`, name: definition.name, args: {} },
        dispatchCtx,
      );
      expect(result.ok, `${definition.name} was advertised but not serviced`).toBe(true);
      expect(result.code).not.toBe(REALTIME_UNKNOWN_TOOL);
    }
  });

  it('refuses a name it never advertised instead of leaving the call hanging', async () => {
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x')),
    });

    const result = await host.dispatch({ callId: 'c1', name: 'send_email', args: {} }, dispatchCtx);

    expect(result.ok).toBe(false);
    expect(result.code).toBe(REALTIME_UNKNOWN_TOOL);
  });

  it('offers agent_consult regardless of the personality toolset', () => {
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x')),
      personalityToolset: ['read_file'],
    });
    expect(host.handled).toEqual([AGENT_CONSULT_TOOL]);
  });

  it('drops a safe tool the personality does not have', () => {
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), echoTool('read_file', 'y', 'file')),
      personalityToolset: ['web_search'],
      safeTools: new Set(['read_file']),
    });
    expect(host.handled).toEqual([AGENT_CONSULT_TOOL]);
  });

  it('advertises nothing it does not hold — an unregistered consult is not claimed', () => {
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool('read_file', 'y', 'file')),
    });
    expect(host.handled).toEqual([]);
  });

  it('never advertises an alwaysInclude or MCP tool the allowlist did not name', () => {
    // `toDefinitions` deliberately lets both past its allowlist — on the text
    // path they are gated by `mcp_servers` / `plugins` instead. That is the
    // wrong gate here, and the realtime derivation intersects exactly.
    const always: Tool = { ...echoTool('todo_write', 'y', 'todo'), alwaysInclude: true };
    const mcp = echoTool('mcp__github__create_issue', 'y', 'mcp');
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), always, mcp),
    });
    expect(host.handled).toEqual([AGENT_CONSULT_TOOL]);
  });

  it('the mint and the control lane derive the same list', () => {
    // Advertised at mint (`deriveRealtimeToolset`) vs handled on the lane
    // (`createRealtimeToolHost`). Two call sites, one derivation.
    const registry = registryWith(
      echoTool(AGENT_CONSULT_TOOL, 'x'),
      echoTool('read_file', 'y', 'file'),
    );
    const personalityToolset = ['read_file'];
    const safeTools = new Set(['read_file']);

    const advertised = deriveRealtimeToolset({ registry, personalityToolset, safeTools });
    const host = createRealtimeToolHost({ ...base, registry, personalityToolset, safeTools });

    expect(advertised.map((d) => d.name)).toEqual(host.handled);
  });
});

describe('spoken output', () => {
  it('sanitizes tool output before it can reach the provider', async () => {
    const raw = [
      '<think>the user seems annoyed</think>',
      '## Result',
      'See `/Users/ada/secret/notes.md` and **do not** panic.',
      '```ts',
      'const x = 1;',
      '```',
      'More at https://example.com/a/b?c=d',
    ].join('\n');
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, raw)),
    });

    const { output } = await host.dispatch(
      { callId: 'c1', name: AGENT_CONSULT_TOOL, args: {} },
      dispatchCtx,
    );

    expect(output).not.toContain('<think>');
    expect(output).not.toContain('the user seems annoyed');
    expect(output).not.toContain('```');
    expect(output).not.toContain('/Users/ada/secret/notes.md');
    expect(output).not.toContain('https://example.com');
    expect(output).not.toContain('##');
    expect(output).not.toContain('**');
  });

  it('never answers with an empty string', async () => {
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, '   ')),
    });
    const { output } = await host.dispatch(
      { callId: 'c1', name: AGENT_CONSULT_TOOL, args: {} },
      dispatchCtx,
    );
    expect(output.trim().length).toBeGreaterThan(0);
  });
});

describe('approval surface', () => {
  it('routes every dispatch through before_tool_call with the voice origin', async () => {
    const seen: unknown[] = [];
    const hooks = {
      async fireModifying(name: string, payload: unknown) {
        if (name === 'before_tool_call') seen.push(payload);
        return {};
      },
    } as unknown as HookRegistry;
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'ok')),
      hooks,
    });

    await host.dispatch({ callId: 'c1', name: AGENT_CONSULT_TOOL, args: {} }, dispatchCtx);

    expect(seen).toEqual([
      {
        sessionId: 'row-1',
        toolCallId: 'c1',
        toolName: AGENT_CONSULT_TOOL,
        args: {},
        voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
      },
    ]);
  });

  it('a hook refusal blocks execution and is spoken back', async () => {
    let ran = false;
    const blocked: Tool = {
      ...echoTool('send_email', 'sent', 'email'),
      async execute() {
        ran = true;
        return { ok: true, value: 'sent' };
      },
    };
    const hooks = {
      async fireModifying() {
        return { error: 'send_email was requested out loud — confirm it verbally first' };
      },
    } as unknown as HookRegistry;
    const host = createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), blocked),
      hooks,
      personalityToolset: ['send_email'],
      safeTools: new Set(['send_email']),
    });

    const result = await host.dispatch({ callId: 'c1', name: 'send_email', args: {} }, dispatchCtx);

    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('confirm it verbally');
  });
});

// F-A2 — the realtime host crosses core's per-call gate (`enforceBeforeToolCall`)
// and result redaction (`redactToolResultSecrets`), not a hand-rolled copy.
// REALTIME_SAFE_TOOLS is empty in production, so these inject a safe-tool set.
describe('core enforcement', () => {
  function gatedHost(opts: {
    personality: PersonalityConfig | undefined;
    tool: Tool;
    hooks?: HookRegistry;
    safetyEvents?: string[];
  }) {
    const events = opts.safetyEvents;
    return createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), opts.tool),
      personality: opts.personality,
      resultRedaction: {
        redaction: testRedaction,
        ...(events
          ? {
              observability: {
                startTurnTrace: () => 'tr',
                endTrace: () => {},
                startSpan: () => 'sp',
                endSpan: () => {},
                recordSafetyBlock: (e: { code?: string }) => events.push(e.code ?? ''),
                recordCompaction: () => {},
                recordTierEscalation: () => {},
                recordTierOverride: () => {},
                flush: () => {},
              },
            }
          : {}),
      },
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      personalityToolset: [opts.tool.name],
      safeTools: new Set([opts.tool.name]),
    });
  }

  function trackingTool(name: string, value: string, ran: { count: number }): Tool {
    return {
      ...echoTool(name, value, 'file'),
      async execute() {
        ran.count++;
        return { ok: true, value };
      },
    };
  }

  const guarded: PersonalityConfig = {
    id: 'researcher',
    name: 'Researcher',
    safety: { denyRules: ['/etc/shadow'] },
  };

  it('a deny-rule match is refused before any hook runs', async () => {
    const ran = { count: 0 };
    let hookCalls = 0;
    const hooks = {
      async fireModifying() {
        hookCalls++;
        return {};
      },
    } as unknown as HookRegistry;
    const events: string[] = [];
    const host = gatedHost({
      personality: guarded,
      tool: trackingTool('read_file', 'root:x', ran),
      hooks,
      safetyEvents: events,
    });

    const result = await host.dispatch(
      { callId: 'c1', name: 'read_file', args: { path: '/etc/shadow' } },
      { ...dispatchCtx, personalityId: 'researcher' },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('refused');
    expect(result.output).toContain('deny rule');
    expect(hookCalls).toBe(0);
    expect(ran.count).toBe(0);
    expect(events).toEqual(['deny_rule']);
  });

  it('a hook that rewrites args into a denied value is refused', async () => {
    const ran = { count: 0 };
    const hooks = {
      async fireModifying() {
        return { args: { path: '/etc/shadow' } };
      },
    } as unknown as HookRegistry;
    const host = gatedHost({
      personality: guarded,
      tool: trackingTool('read_file', 'root:x', ran),
      hooks,
    });

    const result = await host.dispatch(
      { callId: 'c1', name: 'read_file', args: { path: '/tmp/notes.md' } },
      { ...dispatchCtx, personalityId: 'researcher' },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('deny rule');
    expect(ran.count).toBe(0);
  });

  it('a secret in the result is redacted before it reaches the session', async () => {
    const events: string[] = [];
    const host = gatedHost({
      personality: guarded,
      tool: echoTool('read_file', `the key is ${SECRET}`, 'file'),
      safetyEvents: events,
    });

    const result = await host.dispatch(
      { callId: 'c1', name: 'read_file', args: { path: '/tmp/env' } },
      { ...dispatchCtx, personalityId: 'researcher' },
    );

    expect(result.ok).toBe(true);
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain('REDACTED');
    expect(events).toEqual(['secret_in_tool_result']);
  });

  it('the before_tool_call payload carries personalityId', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const hooks = {
      async fireModifying(name: string, payload: Record<string, unknown>) {
        if (name === 'before_tool_call') seen.push(payload);
        return {};
      },
    } as unknown as HookRegistry;
    const host = gatedHost({
      personality: guarded,
      tool: echoTool('read_file', 'ok', 'file'),
      hooks,
    });

    await host.dispatch(
      { callId: 'c1', name: 'read_file', args: {} },
      { ...dispatchCtx, personalityId: 'researcher' },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.personalityId).toBe('researcher');
    expect(seen[0]?.voiceOrigin).toEqual(dispatchCtx.voiceOrigin);
  });
});

// A realtime call runs tools outside any AgentLoop run, so the host is the only
// thing that can carry the per-run plugin context store — and it is created per
// session (`apps/web-api/src/voice/realtime-control-deps.ts`), which makes the
// call itself the scope.
describe('ToolContext parity — the realtime host', () => {
  function recorder(seen: Array<Parameters<Tool['execute']>[1]>): Tool {
    return {
      ...echoTool('read_file', 'file contents', 'file'),
      async execute(_args, ctx) {
        seen.push(ctx);
        return { ok: true, value: 'file contents' };
      },
    };
  }

  function hostWith(seen: Array<Parameters<Tool['execute']>[1]>) {
    return createRealtimeToolHost({
      ...base,
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), recorder(seen)),
      personalityToolset: ['read_file'],
      safeTools: new Set(['read_file']),
    });
  }

  it('hands the tool the context accessors and rootSessionKey', async () => {
    const seen: Array<Parameters<Tool['execute']>[1]> = [];
    await hostWith(seen).dispatch({ callId: 'c1', name: 'read_file', args: {} }, dispatchCtx);

    expect(typeof seen[0]?.getContext).toBe('function');
    expect(typeof seen[0]?.setContext).toBe('function');
    expect(seen[0]?.rootSessionKey).toBe(dispatchCtx.sessionKey);
  });

  it('one store per call: shared across its dispatches, never across two calls', async () => {
    const seen: Array<Parameters<Tool['execute']>[1]> = [];
    const host = hostWith(seen);
    await host.dispatch({ callId: 'c1', name: 'read_file', args: {} }, dispatchCtx);
    seen[0]?.setContext?.('who', 'first call');
    await host.dispatch({ callId: 'c2', name: 'read_file', args: {} }, dispatchCtx);
    expect(seen[1]?.getContext?.('who')).toBe('first call');

    const other: Array<Parameters<Tool['execute']>[1]> = [];
    await hostWith(other).dispatch({ callId: 'c3', name: 'read_file', args: {} }, dispatchCtx);
    expect(other[0]?.getContext?.('who')).toBeUndefined();
  });
});

describe('memory scope', () => {
  // A voice call is a conversation with a personality, so the real memory
  // tools run against that personality's scope — the one AgentLoop stamps.
  class ScopedMemory implements MemoryProvider {
    readonly store = new Map<string, string>();
    async prefetch() {
      return null;
    }
    async read(key: string, ctx: MemoryContext) {
      const content = this.store.get(`${ctx.scopeId}/${key}`);
      return content === undefined ? null : { key, content };
    }
    async search() {
      return [];
    }
    async sync(updates: MemoryUpdate[], ctx: MemoryContext) {
      for (const u of updates) {
        if (u.action === 'add' || u.action === 'replace') {
          this.store.set(`${ctx.scopeId}/${u.key}`, u.content);
        }
      }
    }
    async list() {
      return [];
    }
  }

  function memoryHost(memory: MemoryProvider) {
    const registry = registryWith(createMemoryWriteTool(memory), createMemoryReadTool(memory));
    return createRealtimeToolHost({
      ...base,
      registry,
      personalityToolset: ['memory_read', 'memory_write'],
      safeTools: new Set(['memory_read', 'memory_write']),
    });
  }

  it("writes and reads the speaking personality's memory scope", async () => {
    const memory = new ScopedMemory();
    const host = memoryHost(memory);
    const ctx = { ...dispatchCtx, personalityId: 'researcher' };

    const write = await host.dispatch(
      {
        callId: 'w1',
        name: 'memory_write',
        args: { store: 'memory', action: 'replace', content: 'Prefers morning calls.' },
      },
      ctx,
    );
    expect(write.ok).toBe(true);
    expect([...memory.store.keys()]).toEqual(['personality:researcher/MEMORY.md']);

    const read = await host.dispatch(
      { callId: 'r1', name: 'memory_read', args: { store: 'memory' } },
      ctx,
    );
    expect(read.ok).toBe(true);
    expect(read.output).toContain('Prefers morning calls.');
  });

  it('without a personality there is no scope, and the memory tools say so', async () => {
    const memory = new ScopedMemory();
    const host = memoryHost(memory);

    const result = await host.dispatch(
      { callId: 'r1', name: 'memory_read', args: { store: 'memory' } },
      dispatchCtx,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_available');
    expect(memory.store.size).toBe(0);
  });
});
