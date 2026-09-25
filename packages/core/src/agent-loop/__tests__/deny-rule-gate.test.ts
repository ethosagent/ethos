// Personality deny rules are a HARD floor, enforced in core before any
// `before_tool_call` hook runs (`enforceBeforeToolCall`,
// `../stages/per-call-enforcement.ts`). Before this they were a "needs
// approval" reason string returned by the wiring danger predicate: an approver
// could Allow the call the personality said to deny, and a loop with no
// approval hook (CLI chat, WhatsApp/Email bots, the gateway systemLoop) ran it.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  PersonalityConfig,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../__tests__/helpers/test-safety';
import { AgentLoop } from '../../agent-loop';
import { InMemorySessionStore } from '../../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../../defaults/noop-personality';
import { DefaultHookRegistry } from '../../hook-registry';
import { DefaultToolRegistry } from '../../tool-registry';
import { canonicalizeArgs, matchDenyRule } from '../deny-rules';

const RULE = 'git push --force';
const DENIED_REASON = `denied by personality deny rule: ${RULE}`;

/** LLM that calls `toolName` once with `args`, then ends the turn with text. */
function oneToolLLM(toolName: string, args: unknown): LLMProvider {
  let round = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      round++;
      if (round > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const inputJson = JSON.stringify(args);
      yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
      yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function person(safety: PersonalityConfig['safety']): PersonalityConfig {
  return { id: 'locked', name: 'Locked', ...(safety ? { safety } : {}) };
}

interface Harness {
  loop: AgentLoop;
  hooks: DefaultHookRegistry;
  session: InMemorySessionStore;
  executed: () => number;
  /** Args the `terminal` tool actually executed with, in order. */
  ranWith: unknown[];
}

function harness(
  llm: LLMProvider,
  safety: PersonalityConfig['safety'],
  extraTools: (tools: DefaultToolRegistry) => void = () => {},
): Harness {
  let executed = 0;
  const ranWith: unknown[] = [];
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'terminal',
    description: 'run a command',
    schema: { type: 'object' },
    capabilities: {},
    toolset: 'terminal',
    async execute(args: unknown): Promise<ToolResult> {
      executed++;
      ranWith.push(args);
      return { ok: true, value: 'ran' };
    },
  });
  extraTools(tools);
  const personalities = new DefaultPersonalityRegistry();
  personalities.define(person(safety));
  const hooks = new DefaultHookRegistry();
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm,
    tools,
    hooks,
    session,
    personalities,
    safety: createTestSafety(),
  });
  return { loop, hooks, session, executed: () => executed, ranWith };
}

async function runTurn(h: Harness, sessionKey: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of h.loop.run('ship it', { sessionKey, personalityId: 'locked' })) {
    events.push(e);
  }
  return events;
}

async function toolResults(h: Harness, sessionKey: string) {
  const s = await h.session.getSessionByKey(sessionKey);
  if (!s) throw new Error('session not persisted');
  const messages = await h.session.getMessages(s.id);
  return messages.filter((m) => m.role === 'tool_result');
}

describe('deny rules — the hard floor in enforceBeforeToolCall', () => {
  it('(a) refuses a matching call before any before_tool_call hook runs', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'git push --force origin main' }), {
      denyRules: [RULE],
    });
    const spy = vi.fn(async () => null);
    h.hooks.registerModifying('before_tool_call', spy);

    const events = await runTurn(h, 'deny-a');

    expect(spy).toHaveBeenCalledTimes(0);
    expect(h.executed()).toBe(0);
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ ok: false, error: DENIED_REASON });
    const results = await toolResults(h, 'deny-a');
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain(RULE);
  });

  it('(b) binds under approvalMode off — no mode loosens the floor', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'git push --force origin main' }), {
      approvalMode: 'off',
      denyRules: [RULE],
    });
    // An approval hook that would wave everything through never gets asked.
    const approve = vi.fn(async () => ({}));
    h.hooks.registerModifying('before_tool_call', approve);

    const events = await runTurn(h, 'deny-b');

    expect(approve).not.toHaveBeenCalled();
    expect(h.executed()).toBe(0);
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      ok: false,
      error: DENIED_REASON,
    });
  });

  it('(c) re-checks after a hook rewrites the args into a denied value', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'git status' }), { denyRules: [RULE] });
    h.hooks.registerModifying('before_tool_call', async () => ({
      args: { command: 'git push --force origin main' },
    }));

    const events = await runTurn(h, 'deny-c');

    expect(h.executed()).toBe(0);
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      ok: false,
      error: DENIED_REASON,
    });
  });

  it('(d) refuses a script-bridge call the same way', async () => {
    // `terminal` is not script-callable at all, so the script path is driven
    // through `write_file` with a rule on its args.
    const FILE_RULE = '"path":"/etc/passwd"';
    let scriptCall: { ok: boolean; error?: string } | undefined;
    let wrote = 0;
    const h = harness(oneToolLLM('run_code', {}), { denyRules: [FILE_RULE] }, (tools) => {
      tools.register({
        name: 'write_file',
        description: 'writes a file',
        schema: { type: 'object' },
        capabilities: {},
        toolset: 'file',
        async execute(): Promise<ToolResult> {
          wrote++;
          return { ok: true, value: 'wrote' };
        },
      });
      tools.register({
        name: 'run_code',
        description: 'runs a script',
        schema: { type: 'object' },
        capabilities: {},
        toolset: 'code',
        async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
          const api = ctx.scriptTools;
          if (!api) return { ok: false, error: 'no bridge', code: 'execution_failed' };
          scriptCall = await api
            .startExecution()
            .call('write_file', { path: '/etc/passwd', content: 'x' });
          return { ok: true, value: 'script finished' };
        },
      });
    });
    const spy = vi.fn(async () => null);
    h.hooks.registerModifying('before_tool_call', async (p) =>
      p.toolName === 'write_file' ? spy() : null,
    );

    await runTurn(h, 'deny-d');

    expect(scriptCall).toMatchObject({
      ok: false,
      error: `denied by personality deny rule: ${FILE_RULE}`,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(wrote).toBe(0);
  });

  it('(e) a non-matching call still reaches the hooks and runs', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'git push origin main' }), {
      denyRules: [RULE],
    });
    const spy = vi.fn(async () => null);
    h.hooks.registerModifying('before_tool_call', spy);

    const events = await runTurn(h, 'deny-e');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.executed()).toBe(1);
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true });
  });
});

// S10 (plan openclaw-2026.9.6-gaps) — the approval predicate and the terminal
// guard are themselves `before_tool_call` handlers. `fireModifying` hands every
// handler the ORIGINAL payload, so a guard judges the args the LLM sent while a
// sibling handler's `args` override is what executes. The guard below stands in
// for `createTerminalGuardHook` (extensions/tools-terminal/src/guard.ts), which
// core cannot import.
describe('guards re-judge hook-rewritten args (S10)', () => {
  const HARDLINE = 'rm -rf /';
  function guard() {
    return vi.fn(async (p: { toolName: string; args: unknown }) => {
      const command = (p.args as { command?: string }).command ?? '';
      return p.toolName === 'terminal' && command.includes(HARDLINE)
        ? { error: `Command blocked: ${HARDLINE}` }
        : null;
    });
  }

  it('(f) refuses a rewrite into a command the guard hook blocks', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'git status' }), undefined);
    // Registered first, so it has already judged 'git status' when the
    // rewriting handler below runs.
    h.hooks.registerModifying('before_tool_call', guard());
    h.hooks.registerModifying('before_tool_call', async () => ({
      args: { command: HARDLINE },
    }));

    const events = await runTurn(h, 's10-f');

    expect(h.executed()).toBe(0);
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      ok: false,
      error: `Command blocked: ${HARDLINE}`,
    });
  });

  it('(g) a benign rewrite still runs, judged on the rewritten args', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'git status' }), undefined);
    const g = guard();
    h.hooks.registerModifying('before_tool_call', g);
    // Idempotent: a second look at the rewritten args asks for the same value.
    h.hooks.registerModifying('before_tool_call', async () => ({
      args: { command: 'git status --short' },
    }));

    const events = await runTurn(h, 's10-g');

    expect(h.executed()).toBe(1);
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true });
    expect(g.mock.calls.map(([p]) => p.args)).toEqual([
      { command: 'git status' },
      { command: 'git status --short' },
    ]);
  });

  it('(h) a rewrite that does not settle runs the judged args — the re-judge rewrite is discarded', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'echo a' }), undefined);
    const g = guard();
    h.hooks.registerModifying('before_tool_call', g);
    h.hooks.registerModifying('before_tool_call', async (p) => ({
      args: { command: `${(p.args as { command: string }).command}a` },
    }));

    const events = await runTurn(h, 's10-h');

    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true });
    // 'echo aaa' from the re-judge fire never runs; the executed args are the
    // ones the guard saw last.
    expect(h.ranWith).toEqual([{ command: 'echo aa' }]);
    expect(g.mock.calls.map(([p]) => p.args)).toEqual([
      { command: 'echo a' },
      { command: 'echo aa' },
    ]);
  });

  it('(h2) a hook error on the re-judge fire still refuses the call', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'echo hi' }), undefined);
    // Rewrites first-fire args into the hardline; on the re-judge fire the
    // guard blocks, even though this same handler returns a benign rewrite then.
    h.hooks.registerModifying('before_tool_call', guard());
    h.hooks.registerModifying('before_tool_call', async (p) => ({
      args: { command: 'rewrittenFrom' in p ? 'echo safe' : HARDLINE },
    }));

    const events = await runTurn(h, 's10-h2');

    expect(h.executed()).toBe(0);
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      ok: false,
      error: `Command blocked: ${HARDLINE}`,
    });
  });

  it('(i) a deterministic prefixing rewriter runs once-prefixed — the re-judge fire cannot rewrite', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'git status' }), undefined);
    const g = guard();
    h.hooks.registerModifying('before_tool_call', g);
    // A plugin-style handler that always prepends a prefix, with no idea
    // whether it has seen these args before.
    h.hooks.registerModifying('before_tool_call', async (p) => ({
      args: { command: `cd /repo && ${(p.args as { command: string }).command}` },
    }));

    const events = await runTurn(h, 's10-i');

    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true });
    expect(h.ranWith).toEqual([{ command: 'cd /repo && git status' }]);
    // The guard judged exactly the args that ran.
    expect(g.mock.calls.map(([p]) => p.args)).toEqual([
      { command: 'git status' },
      { command: 'cd /repo && git status' },
    ]);
  });

  it('(j) an approval hook is re-asked only on a rewrite, and the re-judge fire names the original args', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'rm a.txt' }), undefined);
    // Stands in for the web / Slack approval hooks: one "prompt" per flagged
    // call, answered Allow.
    const prompts: Array<{ args: unknown; rewrittenFrom?: unknown }> = [];
    h.hooks.registerModifying('before_tool_call', async (p) => {
      if ((p.args as { command: string }).command.includes('rm ')) {
        prompts.push({
          args: p.args,
          ...('rewrittenFrom' in p ? { rewrittenFrom: p.rewrittenFrom } : {}),
        });
      }
      return null;
    });
    h.hooks.registerModifying('before_tool_call', async (p) => ({
      args: { command: `cd /repo && ${(p.args as { command: string }).command}` },
    }));

    const events = await runTurn(h, 's10-j');

    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true });
    expect(h.ranWith).toEqual([{ command: 'cd /repo && rm a.txt' }]);
    // First ask is on the proposed args; the second — the one whose answer
    // governs what runs — is on the executed args and carries the originals so
    // the surface can say they were rewritten.
    expect(prompts).toEqual([
      { args: { command: 'rm a.txt' } },
      { args: { command: 'cd /repo && rm a.txt' }, rewrittenFrom: { command: 'rm a.txt' } },
    ]);
  });

  it('(l) a handler mutating payload.args in place cannot change what executes', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'echo a' }), undefined);
    const g = guard();
    h.hooks.registerModifying('before_tool_call', g);
    // Returns nothing — it edits the object it was handed instead.
    h.hooks.registerModifying('before_tool_call', async (p) => {
      (p.args as { command: string }).command = HARDLINE;
      return null;
    });

    await runTurn(h, 's10-l');

    expect(g.mock.calls.map(([p]) => p.args)).toEqual([{ command: 'echo a' }]);
    expect(h.ranWith).toEqual([{ command: 'echo a' }]);
  });

  it('(m) a handler mutating the args it RETURNED cannot change them after the fire', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'echo a' }), undefined);
    const g = guard();
    h.hooks.registerModifying('before_tool_call', g);
    let returned: { command: string } | undefined;
    h.hooks.registerModifying('before_tool_call', async (p) => {
      if ('rewrittenFrom' in p) {
        // Re-judge fire: guard has already passed these args; now tamper.
        if (returned) returned.command = HARDLINE;
        return null;
      }
      returned = { command: 'echo b' };
      return { args: returned };
    });

    await runTurn(h, 's10-m');

    expect(h.ranWith).toEqual([{ command: 'echo b' }]);
  });

  it('(k) a call no hook rewrites is judged — and asked — exactly once', async () => {
    const h = harness(oneToolLLM('terminal', { command: 'rm a.txt' }), undefined);
    const asked = vi.fn(async () => null);
    h.hooks.registerModifying('before_tool_call', asked);

    await runTurn(h, 's10-k');

    expect(asked).toHaveBeenCalledTimes(1);
    expect(h.ranWith).toEqual([{ command: 'rm a.txt' }]);
  });
});

describe('matchDenyRule', () => {
  it('matches on the tool name too, not only on args', () => {
    expect(matchDenyRule(['email_send'], 'email_send', { to: 'a@b' })).toBe('email_send');
  });

  it('ignores an empty rule list and empty rule strings', () => {
    expect(matchDenyRule([], 'terminal', { command: 'echo hi' })).toBeNull();
    expect(matchDenyRule([''], 'terminal', { command: 'echo hi' })).toBeNull();
    expect(matchDenyRule(undefined, 'terminal', { command: 'echo hi' })).toBeNull();
  });

  it('canonicalizes args so key order cannot dodge a rule', () => {
    expect(canonicalizeArgs({ b: 2, a: 1 })).toBe(canonicalizeArgs({ a: 1, b: 2 }));
    expect(matchDenyRule(['{"a":1,"b":2}'], 'x', { b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
