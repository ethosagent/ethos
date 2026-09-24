// Item 7 (openclaw-advisory-fixes, D17) — secret redaction runs once, right
// after a tool result resolves, on BOTH the value and the error variant, and
// before `tool_end`, `after_tool_call` and persistence read it. Pins
// `redactToolResultSecrets` (../result-redaction.ts) at its two call sites:
// `processTools` (../tool-processing.ts) and `ScriptToolBridge.dispatch`
// (../script-tool-bridge.ts).

import type {
  AfterToolCallPayload,
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../__tests__/helpers/test-safety';
import { AgentLoop } from '../../../agent-loop';
import { InMemorySessionStore } from '../../../defaults/in-memory-session';
import { makeTestToolContext } from '../../../defaults/in-memory-tool-context';
import { DefaultPersonalityRegistry } from '../../../defaults/noop-personality';
import { DefaultHookRegistry } from '../../../hook-registry';
import type { AgentLoopObservability } from '../../../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../../../tool-registry';
import { checkTurnBudgets } from '../../budgets';
import { createTurnBudgetCounters } from '../per-call-enforcement';
import {
  MAX_STRUCTURED_DEPTH,
  redactToolResultSecrets,
  UNSCANNABLE_MARKER,
} from '../result-redaction';
import { ScriptToolBridge } from '../script-tool-bridge';

// A GitHub PAT that `detectSecrets` recognises; `redactString` replaces it with
// the marker below.
const SECRET = 'ghp_abcdefghij1234567890abcdefghij123456';
const MARKER = '[REDACTED:github-pat]';

type ToolEnd = Extract<AgentEvent, { type: 'tool_end' }>;

function leakyTool(result: ToolResult): Tool {
  return {
    name: 'leaky',
    description: 'returns a secret-shaped string',
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => result,
  };
}

/** Scripted LLM: one `leaky` tool_use, then a plain end_turn. */
function oneCallLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'leaky' };
      yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function runLeaky(result: ToolResult, blockSecretResults?: boolean) {
  const tools = new DefaultToolRegistry();
  tools.register(leakyTool(result));
  const session = new InMemorySessionStore();
  const hooks = new DefaultHookRegistry();
  const afterPayloads: AfterToolCallPayload[] = [];
  hooks.registerVoid('after_tool_call', async (p) => {
    afterPayloads.push(p);
  });
  const safetyEvents: Array<{ code?: string; cause?: string }> = [];
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'tr1',
    endTrace: () => {},
    startSpan: () => 'sp1',
    endSpan: () => {},
    recordSafetyBlock: (e) => safetyEvents.push({ code: e.code, cause: e.cause }),
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({
    id: 'default',
    name: 'Default',
    safety: {
      injectionDefense: blockSecretResults === undefined ? {} : { blockSecretResults },
    },
  });
  personalities.setDefault('default');
  const loop = new AgentLoop({
    llm: oneCallLLM(),
    tools,
    hooks,
    session,
    personalities,
    observability,
    safety: createTestSafety(),
  });
  const events: AgentEvent[] = [];
  for await (const e of loop.run('go', { sessionKey: 'redaction' })) events.push(e);
  const stored = await session.getSessionByKey('redaction');
  const messages = stored ? await session.getMessages(stored.id) : [];
  const persisted = messages.filter((m) => m.role === 'tool_result').map((m) => m.content);
  const toolEnds = events.filter((e): e is ToolEnd => e.type === 'tool_end');
  return { toolEnds, persisted, afterPayloads, safetyEvents };
}

describe('Item 7 — tool-result secret redaction', () => {
  it('(a) ok:false — persisted tool_result, tool_end.error and tool_end.result are redacted', async () => {
    const r = await runLeaky({
      ok: false,
      error: `GET https://api.example/v1?token=${SECRET} failed: 401`,
      code: 'execution_failed',
    });
    expect(r.persisted).toHaveLength(1);
    expect(r.persisted[0]).toContain(MARKER);
    expect(r.persisted[0]).not.toContain(SECRET);
    const end = r.toolEnds[0];
    expect(end?.ok).toBe(false);
    expect(end?.error).toContain(MARKER);
    expect(end?.error).not.toContain(SECRET);
    expect(String(end?.result)).not.toContain(SECRET);
    expect(JSON.stringify(r.afterPayloads)).not.toContain(SECRET);
    expect(r.safetyEvents.map((e) => e.code)).toContain('secret_in_tool_result');
  });

  it('(b) ok:true — tool_end.result and the after_tool_call payload are redacted', async () => {
    const r = await runLeaky({ ok: true, value: `token: ${SECRET}` });
    const end = r.toolEnds[0];
    expect(end?.ok).toBe(true);
    expect(end?.result).toContain(MARKER);
    expect(String(end?.result)).not.toContain(SECRET);
    expect(r.afterPayloads).toHaveLength(1);
    const after = r.afterPayloads[0]?.result;
    expect(after?.ok).toBe(true);
    expect(after?.ok ? after.value : '').toContain(MARKER);
    expect(JSON.stringify(r.afterPayloads)).not.toContain(SECRET);
    expect(r.persisted[0]).not.toContain(SECRET);
  });

  it('(c) blockSecretResults:false leaves both variants untouched but still records the event', async () => {
    const failed = await runLeaky(
      { ok: false, error: `key=${SECRET}`, code: 'execution_failed' },
      false,
    );
    expect(failed.toolEnds[0]?.error).toContain(SECRET);
    expect(failed.persisted[0]).toContain(SECRET);
    expect(failed.safetyEvents.map((e) => e.code)).toContain('secret_in_tool_result');

    const ok = await runLeaky({ ok: true, value: `key=${SECRET}` }, false);
    expect(ok.toolEnds[0]?.result).toContain(SECRET);
    expect(ok.persisted[0]).toContain(SECRET);
    expect(ok.safetyEvents.map((e) => e.code)).toContain('secret_in_tool_result');
  });

  it('(f) a secret nested in structured is redacted in tool_end.structured and after_tool_call', async () => {
    const r = await runLeaky({
      ok: true,
      value: 'fetched 1 row',
      structured: { rows: [{ name: 'svc', auth: { header: `Bearer ${SECRET}` } }], count: 1 },
    });
    const end = r.toolEnds[0];
    expect(end?.structured).toEqual({
      rows: [{ name: 'svc', auth: { header: `Bearer ${MARKER}` } }],
      count: 1,
    });
    const after = r.afterPayloads[0]?.result;
    expect(after?.ok ? after.structured : undefined).toEqual(end?.structured);
    expect(JSON.stringify(r.toolEnds)).not.toContain(SECRET);
    expect(JSON.stringify(r.afterPayloads)).not.toContain(SECRET);
    expect(r.safetyEvents.filter((e) => e.code === 'secret_in_tool_result')).toHaveLength(1);
  });

  it('(g) blockSecretResults:false leaves structured untouched but records the event', async () => {
    const r = await runLeaky(
      { ok: true, value: 'ok', structured: { deep: [{ token: SECRET }] } },
      false,
    );
    expect(r.toolEnds[0]?.structured).toEqual({ deep: [{ token: SECRET }] });
    expect(r.safetyEvents.filter((e) => e.code === 'secret_in_tool_result')).toHaveLength(1);
  });

  it('(h) exactly one event when both value and structured carry the secret', async () => {
    const r = await runLeaky({
      ok: true,
      value: `token: ${SECRET}`,
      structured: { token: SECRET },
    });
    expect(r.toolEnds[0]?.result).toContain(MARKER);
    expect(r.toolEnds[0]?.structured).toEqual({ token: MARKER });
    expect(r.safetyEvents.filter((e) => e.code === 'secret_in_tool_result')).toHaveLength(1);
  });

  it('(i) the tool result object is not mutated', () => {
    const structured = { nested: { list: [SECRET, 7, null, true] } };
    const original: ToolResult = { ok: true, value: 'x', structured };
    const events: string[] = [];
    const out = redactToolResultSecrets(
      original,
      {
        redaction: createTestSafety().redaction,
        observability: {
          startTurnTrace: () => 'tr1',
          endTrace: () => {},
          startSpan: () => 'sp1',
          endSpan: () => {},
          recordSafetyBlock: (e) => events.push(e.code ?? ''),
          recordCompaction: () => {},
          recordTierEscalation: () => {},
          recordTierOverride: () => {},
          flush: () => {},
        },
      },
      { personality: { id: 'default', name: 'Default' }, traceId: undefined },
    );
    expect(out.ok ? out.structured : undefined).toEqual({
      nested: { list: [MARKER, 7, null, true] },
    });
    expect(structured).toEqual({ nested: { list: [SECRET, 7, null, true] } });
    expect(original.ok ? original.structured : undefined).toBe(structured);
    expect(events).toEqual(['secret_in_tool_result']);
  });

  it('(j) a cyclic or over-deep structured subtree fails closed to the unscannable marker', () => {
    const cyclic: Record<string, unknown> = { label: 'ok' };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < MAX_STRUCTURED_DEPTH + 5; i++) deep = { next: deep };
    const shared = { v: 'same' };
    const deps = { redaction: createTestSafety().redaction };
    const ctx = { personality: { id: 'default', name: 'Default' }, traceId: undefined };

    const outCyclic = redactToolResultSecrets(
      { ok: true, value: 'x', structured: cyclic },
      deps,
      ctx,
    );
    expect(outCyclic.ok ? outCyclic.structured : undefined).toEqual({
      label: 'ok',
      self: UNSCANNABLE_MARKER,
    });
    expect(cyclic.self).toBe(cyclic);

    const outDeep = redactToolResultSecrets({ ok: true, value: 'x', structured: deep }, deps, ctx);
    expect(JSON.stringify(outDeep.ok ? outDeep.structured : null)).toContain(UNSCANNABLE_MARKER);
    expect(JSON.stringify(outDeep.ok ? outDeep.structured : null)).not.toContain('bottom');

    // A shared (non-cyclic) reference is scanned, not treated as a cycle.
    const sharedIn: ToolResult = { ok: true, value: 'x', structured: { a: shared, b: shared } };
    expect(redactToolResultSecrets(sharedIn, deps, ctx)).toBe(sharedIn);
  });

  it('(e) returnDirect batch: sibling tool_end, persisted rows and done.text are redacted', async () => {
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'answer',
      description: 'returnDirect tool whose answer carries a secret',
      schema: { type: 'object' },
      capabilities: {},
      returnDirect: true,
      execute: async () => ({ ok: true, value: `your token is ${SECRET}` }),
    });
    tools.register({
      name: 'sibling',
      description: 'errors with a secret',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({
        ok: false,
        error: `POST https://api.example/?key=${SECRET} failed`,
        code: 'execution_failed',
      }),
    });
    let calls = 0;
    const llm: LLMProvider = {
      name: 'scripted',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        calls++;
        if (calls > 1) {
          yield { type: 'done', finishReason: 'end_turn' };
          return;
        }
        yield { type: 'tool_use_start', toolCallId: 'a1', toolName: 'answer' };
        yield { type: 'tool_use_end', toolCallId: 'a1', inputJson: '{}' };
        yield { type: 'tool_use_start', toolCallId: 's1', toolName: 'sibling' };
        yield { type: 'tool_use_end', toolCallId: 's1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
      },
      async countTokens() {
        return 1;
      },
    };
    const session = new InMemorySessionStore();
    const safetyEvents: string[] = [];
    const loop = new AgentLoop({
      llm,
      tools,
      session,
      observability: {
        startTurnTrace: () => 'tr1',
        endTrace: () => {},
        startSpan: () => 'sp1',
        endSpan: () => {},
        recordSafetyBlock: (e) => safetyEvents.push(e.code ?? ''),
        recordCompaction: () => {},
        recordTierEscalation: () => {},
        recordTierOverride: () => {},
        flush: () => {},
      },
      safety: createTestSafety(),
    });
    const events: AgentEvent[] = [];
    for await (const e of loop.run('go', { sessionKey: 'direct' })) events.push(e);
    const stored = await session.getSessionByKey('direct');
    const messages = stored ? await session.getMessages(stored.id) : [];

    const siblingEnd = events.find(
      (e): e is ToolEnd => e.type === 'tool_end' && e.toolName === 'sibling',
    );
    expect(siblingEnd?.error).toContain(MARKER);
    expect(String(siblingEnd?.result)).not.toContain(SECRET);
    const siblingRow = messages.find((m) => m.role === 'tool_result' && m.toolName === 'sibling');
    expect(siblingRow?.content).toContain(MARKER);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' ? done.text : '').toContain(MARKER);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(messages)).not.toContain(SECRET);
    // One event per affected result (answer + sibling), never a second pass.
    expect(safetyEvents.filter((c) => c === 'secret_in_tool_result')).toHaveLength(2);
  });

  it('(d) script-bridge inner call: redacted tool_end.error and redacted text returned to the script', async () => {
    const tools = new DefaultToolRegistry();
    // The script surface is gated on run_code being registered.
    tools.register({
      name: 'run_code',
      description: 'stub',
      schema: { type: 'object' },
      capabilities: {},
      toolset: 'code',
      execute: async () => ({ ok: true, value: '' }),
    });
    tools.register(
      leakyTool({ ok: false, error: `auth failed for ${SECRET}`, code: 'execution_failed' }),
    );
    const counters = createTurnBudgetCounters();
    const safetyEvents: string[] = [];
    const bridge = new ScriptToolBridge({
      tools,
      hooks: new DefaultHookRegistry(),
      observability: {
        startTurnTrace: () => 'tr1',
        endTrace: () => {},
        startSpan: () => 'sp1',
        endSpan: () => {},
        recordSafetyBlock: (e) => safetyEvents.push(e.code ?? ''),
        recordCompaction: () => {},
        recordTierEscalation: () => {},
        recordTierOverride: () => {},
        flush: () => {},
      },
      sessionId: 's1',
      traceId: undefined,
      allowedTools: ['run_code', 'leaky'],
      allowedPlugins: [],
      filterOpts: {},
      watcherTap: { observe: () => {}, getHalt: () => null },
      counters,
      checkBudgets: () =>
        checkTurnBudgets(counters.totalToolCalls, 1000, counters.toolNameCounts, 1000, null, 1000),
      redaction: createTestSafety().redaction,
      personality: { id: 'default', name: 'Default' },
    });
    const events: AgentEvent[] = [];
    const ctx = makeTestToolContext();
    const api = bridge.bind(
      () => ctx,
      (e) => events.push(e),
    );
    const res = await api.startExecution().call('leaky', {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain(MARKER);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    const end = events.find((e): e is ToolEnd => e.type === 'tool_end');
    expect(end?.error).toContain(MARKER);
    expect(end?.error).not.toContain(SECRET);
    expect(safetyEvents).toContain('secret_in_tool_result');
  });
});
