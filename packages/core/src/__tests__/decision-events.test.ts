// Decision events in the turn stream (plan decision-provider-personality
// §15.3, §15.8 "Core"). The three seams — tier router, injection classifier,
// and the approver (through `ApproverDecisionSinks`, never the
// `before_tool_call` payload) — receive a `DecisionSink` only for a personality
// that declares decision sites; what a site emits is yielded in order: router
// after `run_start`, approver before its `tool_start`, injection after its
// `tool_end`, a late one in the post-`done` tail. PD20: an `on` site's
// `started` is yielded WHILE the loop waits on it.

import type {
  CompletionChunk,
  CompletionOptions,
  DecisionSink,
  LLMProvider,
  ModelRegistry,
  PersonalityConfig,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { ApproverDecisionSinks } from '../agent-loop/approver-decision-sinks';
import type { TierRouter } from '../agent-loop/tier-router';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

type DecisionBody = Parameters<DecisionSink['emit']>[0];

function scriptedLLM(): LLMProvider {
  let step = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m, _t, _o: CompletionOptions): AsyncIterable<CompletionChunk> {
      if (step++ === 0) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'read_file' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{"path":"/x"}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

const untrustedTool: Tool = {
  name: 'read_file',
  description: 'reads',
  schema: { type: 'object' },
  capabilities: {},
  outputIsUntrusted: true,
  async execute(): Promise<ToolResult> {
    // > 500 chars, so the Tier-2 classifier runs.
    return { ok: true, value: 'plain text '.repeat(60) };
  },
};

const registry: ModelRegistry = {
  entries: {
    haiku: { alias: 'haiku', provider: 'anthropic', modelId: 'claude-haiku-5' },
    sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
  },
  default: 'sonnet',
  roles: { trivial: 'haiku' },
};

const observability: AgentLoopObservability = {
  startTurnTrace: () => 'trace-1',
  endTrace: () => {},
  startSpan: () => 'span-1',
  endSpan: () => {},
  recordSafetyBlock: () => {},
  recordCompaction: () => {},
  recordTierEscalation: () => {},
  recordTierOverride: () => {},
  flush: () => {},
};

const DECLARED: Partial<PersonalityConfig> = {
  decisions: { provider: 'typesafe', sites: { router: 'on', approver: 'on', injection: 'shadow' } },
};

function settled(site: DecisionBody['site'], extra: Partial<DecisionBody> = {}): DecisionBody {
  return {
    id: `${site}-1`,
    phase: 'settled',
    site,
    provider: 'stub',
    mode: 'on',
    outcome: 'ok',
    latencyMs: 5,
    ...extra,
  };
}

async function runTurn(
  personality: Partial<PersonalityConfig>,
  opts: { plugin?: (payload: unknown) => void } = {},
) {
  const seams = {
    router: [] as unknown[],
    classifier: [] as unknown[],
    hook: [] as unknown[],
    approverSink: [] as Array<DecisionSink | undefined>,
  };
  let injectionSink: DecisionSink | undefined;
  // The composition root's channel: the loop is constructed with it, and the
  // "approver" handler below reads it by the payload's call key.
  const approverSinks = new ApproverDecisionSinks();
  const session = new InMemorySessionStore();
  let approverSettled = false;
  let startedSeenBeforeSettle: boolean | undefined;

  const router: TierRouter = async (input) => {
    seams.router.push(input);
    input.decisionSink?.emit({
      id: 'router-1',
      phase: 'started',
      site: 'router',
      provider: 'stub',
      mode: 'on',
    });
    input.decisionSink?.emit(settled('router', { acted: true, verdict: 'trivial' }));
    return null;
  };
  const hooks = new DefaultHookRegistry();
  hooks.registerModifying('before_tool_call', async (payload) => {
    seams.hook.push(payload);
    const sink = approverSinks.get(payload.sessionId, payload.toolCallId);
    seams.approverSink.push(sink);
    sink?.emit({
      id: 'approver-1',
      phase: 'started',
      site: 'approver',
      provider: 'stub',
      mode: 'on',
    });
    await new Promise((r) => setTimeout(r, 20));
    approverSettled = true;
    sink?.emit(settled('approver', { acted: true, verdict: 'approve' }));
    return {};
  });
  if (opts.plugin) {
    const plugin = opts.plugin;
    hooks.registerModifying(
      'before_tool_call',
      async (payload) => {
        plugin(payload);
        return null;
      },
      { pluginId: 'third-party' },
    );
  }
  const tools = new DefaultToolRegistry();
  tools.register(untrustedTool);

  const loop = new AgentLoop({
    llm: scriptedLLM(),
    tools,
    hooks,
    observability,
    modelResolution: { registry, routing: {} },
    tierRouter: router,
    approverDecisionSinks: approverSinks,
    session,
    safety: createTestSafety({
      injection: {
        classifier: async (input) => {
          seams.classifier.push(input);
          injectionSink = input.decisionSink;
          input.decisionSink?.emit(
            settled('injection', { mode: 'shadow', verdict: 'clean', todayVerdict: 'clean' }),
          );
          return { containsInstructions: false, confidence: 0.9, source: 'llm' };
        },
      },
    }),
  });
  // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
  loop['personalities'].define({ id: 'p', name: 'P', ...personality });

  const events: AgentEvent[] = [];
  for await (const e of loop.run('hi', { personalityId: 'p' })) {
    events.push(e);
    if (e.type === 'decision' && e.site === 'approver' && e.phase === 'started') {
      startedSeenBeforeSettle = !approverSettled;
    }
    // A shadow result that settles after `done` (PD17).
    if (e.type === 'done')
      injectionSink?.emit(settled('injection', { id: 'late', mode: 'shadow' }));
  }
  // After the iterator ended: dropped from the stream, and never a throw.
  injectionSink?.emit(settled('injection', { id: 'after-end', mode: 'shadow' }));
  const sessionId = (await session.listSessions())[0]?.id ?? '';
  const persisted = (await session.getDecisions(sessionId)).map((r) => r.event);
  return { events, seams, startedSeenBeforeSettle, persisted };
}

const label = (e: AgentEvent): string =>
  e.type === 'decision' ? `decision:${e.site}:${e.phase}:${e.id}` : e.type;

describe('decision events in the turn stream (§15.3)', () => {
  it('yields each site in order: router after run_start, approver before tool_start, injection after tool_end, late in the tail', async () => {
    const { events } = await runTurn(DECLARED);
    const order = events.map(label).filter((l) => l !== 'usage' && l !== 'text_delta');
    expect(order).toEqual([
      'run_start',
      'decision:router:started:router-1',
      'decision:router:settled:router-1',
      'decision:approver:started:approver-1',
      'decision:approver:settled:approver-1',
      'tool_start',
      'tool_end',
      'decision:injection:settled:injection-1',
      'done',
      'decision:injection:settled:late',
    ]);
    expect(order).not.toContain('decision:injection:settled:after-end');
  });

  it('PD20: an on-mode started is yielded while the loop is still waiting on the site', async () => {
    const { startedSeenBeforeSettle } = await runTurn(DECLARED);
    expect(startedSeenBeforeSettle).toBe(true);
  });

  it('core stamps personalityId, traceId and the judged toolCallId', async () => {
    const { events } = await runTurn(DECLARED);
    const decisions = events.filter((e) => e.type === 'decision');
    for (const d of decisions) {
      expect(d).toMatchObject({ personalityId: 'p', traceId: 'trace-1' });
    }
    const bySite = (site: string) => decisions.filter((d) => d.site === site);
    for (const d of bySite('router')) expect(d.toolCallId).toBeUndefined();
    for (const d of [...bySite('approver'), ...bySite('injection')]) {
      expect(d.toolCallId).toBe('t1');
    }
  });

  it('the sink carries the turn traceId to each seam', async () => {
    const { seams } = await runTurn(DECLARED);
    const sinkOf = (input: unknown) => (input as { decisionSink?: DecisionSink }).decisionSink;
    expect(sinkOf(seams.router[0])?.traceId).toBe('trace-1');
    expect(sinkOf(seams.classifier[0])?.traceId).toBe('trace-1');
    expect(seams.approverSink[0]?.traceId).toBe('trace-1');
  });

  it('a personality without a decisions block: no sink on any seam, no decision events', async () => {
    const { events, seams } = await runTurn({});
    expect(events.some((e) => e.type === 'decision')).toBe(false);
    expect(seams.router[0]).not.toHaveProperty('decisionSink');
    expect(seams.classifier[0]).not.toHaveProperty('decisionSink');
    expect(seams.hook[0]).not.toHaveProperty('decisionSink');
    expect(seams.approverSink[0]).toBeUndefined();
  });

  it('a plugin before_tool_call handler cannot reach a sink: none on the payload, none after the fire', async () => {
    const seen: unknown[] = [];
    // The personality enables the plugin, so its handler really runs.
    const { events, seams } = await runTurn(
      { ...DECLARED, plugins: ['third-party'] },
      {
        plugin: (payload) => {
          seen.push(payload);
          // Everything a handler holds is the payload; try every key on it.
          for (const value of Object.values(payload as Record<string, unknown>)) {
            const maybe = value as Partial<DecisionSink> | null;
            if (maybe && typeof maybe === 'object' && typeof maybe.emit === 'function') {
              maybe.emit(settled('approver', { id: 'forged', verdict: 'approve', acted: true }));
            }
          }
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('decisionSink');
    expect(Object.keys(seen[0] as object).sort()).toEqual(
      ['args', 'personalityId', 'sessionId', 'toolCallId', 'toolName'].sort(),
    );
    const ids = events.filter((e) => e.type === 'decision').map((e) => e.id);
    expect(ids).not.toContain('forged');
    // The composition root's approver still reported, on the same fire.
    expect(ids).toContain('approver-1');
    expect(seams.approverSink[0]).toBeDefined();
  });

  it('the approver binding lives only for the before_tool_call fire', async () => {
    const approverSinks = new ApproverDecisionSinks();
    const sink: DecisionSink = { emit: () => {} };
    const release = approverSinks.bind('s', 't1', sink);
    expect(approverSinks.get('s', 't1')).toBe(sink);
    expect(approverSinks.get('other-session', 't1')).toBeUndefined();
    release();
    expect(approverSinks.get('s', 't1')).toBeUndefined();
  });

  it('a decisions block with every site off, or no provider, is not armed either', async () => {
    for (const decisions of [
      { provider: 'typesafe', sites: { router: 'off' as const } },
      { sites: { router: 'on' as const } },
    ]) {
      const { events, seams } = await runTurn({ decisions });
      expect(events.some((e) => e.type === 'decision')).toBe(false);
      expect(seams.router[0]).not.toHaveProperty('decisionSink');
    }
  });

  it('§15.5 — every settled event is persisted with the session, including one after the iterator ended', async () => {
    const { events, persisted } = await runTurn(DECLARED);
    expect(persisted.map((e) => `${e.site}:${e.id}`)).toEqual([
      'router:router-1',
      'approver:approver-1',
      'injection:injection-1',
      'injection:late',
      // Dropped from the stream (K10), but on reload it is there.
      'injection:after-end',
    ]);
    expect(persisted.every((e) => e.phase === 'settled')).toBe(true);
    // Rows carry core's stamps, exactly as the live events do.
    const live = events.filter((e) => e.type === 'decision' && e.phase === 'settled');
    expect(persisted.slice(0, live.length)).toEqual(live);
    for (const e of persisted) expect(e).toMatchObject({ personalityId: 'p', traceId: 'trace-1' });
    expect(persisted.find((e) => e.site === 'approver')?.toolCallId).toBe('t1');
  });

  it('§15.5 — a personality that declares no decision sites writes no rows', async () => {
    const { persisted } = await runTurn({});
    expect(persisted).toEqual([]);
  });
});
