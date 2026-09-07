// Transport hop — proves `ctx.llm` set on the AgentLoop's ToolContext reaches a
// tool through the LocalToolTransport rebuild.
//
// The transport reconstructs the tool ctx from the SERIALIZABLE request plus the
// LIVE side-channel. `ctx.llm` closes over the turn's usage sink, so it can only
// ride the side-channel — this test locks in that it does. It regressed once
// already: a whitelist replaced a ctx spread and silently dropped the handle,
// disabling web_search's chunk summarizer and every plugin tool's model pass.

import type { SimpleCompletion, Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultToolRegistry } from '../tool-registry';

const echoLlm: Tool = {
  name: 'echo_llm',
  description: 'Echoes what the ambient LLM handle on ctx returns.',
  schema: { type: 'object' },
  capabilities: {},
  execute: async (_args, ctx) => {
    const llm = ctx.llm;
    if (!llm) return { ok: true, value: 'no-llm' };
    return { ok: true, value: await llm.complete('ping', { model: 'aux' }) };
  },
};

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: 's1',
  sessionKey: 'cli:default',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 10_000,
  ...overrides,
});

describe('ctx.llm transport hop', () => {
  it('a tool sees the LLM handle carried on the AgentLoop ctx', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoLlm);

    const seen: Array<{ prompt: string; model?: string }> = [];
    const llm: SimpleCompletion = {
      complete: async (prompt, options) => {
        seen.push({ prompt, model: options?.model });
        return `completed:${prompt}`;
      },
    };

    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'echo_llm', args: {} }],
      makeCtx({ llm }),
    );

    const r = results[0]?.result;
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.value).toBe('completed:ping');
    expect(seen).toEqual([{ prompt: 'ping', model: 'aux' }]);
  });

  it('a tool sees no handle when the ctx did not carry one', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoLlm);

    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'echo_llm', args: {} }],
      makeCtx(),
    );

    const r = results[0]?.result;
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.value).toBe('no-llm');
  });
});
