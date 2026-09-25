// Two personalities on ONE AgentLoop get different decision-site modes on
// consecutive turns (plan/phases/decision-provider-personality.md §1 success
// criterion, §11 "Multi-personality", N3 acceptance).
//
// The loop is core's AgentLoop driven by a scripted LLM; each turn calls one
// untrusted tool whose output is long enough (> 500 chars) that core consults
// the injection classifier (`handleUntrustedResult`,
// packages/core/src/agent-loop/result-defense.ts). The classifier is the real
// `createDecisionInjectionClassifier`, reading the SAME registry the loop
// resolves turns from — the wiring `build-agent-loop.ts` does. `judge`
// declares `decisions.sites.injection: shadow`; `plain` declares nothing.
// Only `judge`'s turn may call decide() and produce a `decision.shadow`
// record, and that record names `judge`.

import { resolveDecisionsConfig } from '@ethosagent/config';
import { AgentLoop, DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import {
  c2PatternCheck,
  DOWNGRADE_REJECTION_MESSAGE,
  INJECTION_DEFENSE_PRELUDE,
  resolveDowngradedTools,
  sanitize,
  shortPatternCheck,
  wrapUntrusted,
} from '@ethosagent/safety-injection';
import { detectSecrets, redactPii, redactString } from '@ethosagent/safety-redact';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import type {
  AgentSafety,
  CompletionChunk,
  DecisionRequest,
  DecisionResult,
  InjectionVerdict,
  LLMProvider,
  Tool,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createDecisionInjectionClassifier } from '../decision-injection-classifier';
import { type DecisionCallRecord, DecisionRecordTracker } from '../decision-site';

/** Each turn: one `fetch_doc` tool call, then a text answer. */
function scriptedLLM(): LLMProvider {
  let step = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      const callTool = step++ % 2 === 0;
      if (callTool) {
        const input = JSON.stringify({ url: 'https://docs.example.test/a' });
        yield { type: 'tool_use_start', toolCallId: `t${step}`, toolName: 'fetch_doc' };
        yield { type: 'tool_use_delta', toolCallId: `t${step}`, partialJson: input };
        yield { type: 'tool_use_end', toolCallId: `t${step}`, inputJson: input };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

const LONG_DOC = `Release notes. ${'The quick brown fox jumps over the lazy dog. '.repeat(20)}`;

const fetchDoc: Tool = {
  name: 'fetch_doc',
  description: 'returns external content',
  schema: { type: 'object' },
  capabilities: {},
  outputIsUntrusted: true,
  async execute() {
    return { ok: true, value: LONG_DOC };
  },
};

const TODAY: InjectionVerdict = { containsInstructions: false, confidence: 0.9, source: 'llm' };

describe('two personalities on one AgentLoop — per-personality decision sites', () => {
  it('only the personality that enables the injection site calls decide(), and its record names it', async () => {
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({
      id: 'judge',
      name: 'Judge',
      decisions: { provider: 'typesafe', sites: { injection: 'shadow' } },
    });
    personalities.define({ id: 'plain', name: 'Plain' });

    const requests: DecisionRequest[] = [];
    const decide = vi.fn(async (req: DecisionRequest): Promise<DecisionResult> => {
      requests.push(req);
      return {
        ok: true,
        answers: { injection: { type: 'boolean', p: 0.1, confidence: 0.8 } },
        model: 'jev-1.13.0',
        usage: { inputTokens: 10, outputTokens: 0 },
      };
    });
    const handleGet = vi.fn(async () => ({ name: 'typesafe', calibrated: true, decide }));
    const fallback = vi.fn(async () => TODAY);
    const records: DecisionCallRecord[] = [];
    const tracker = new DecisionRecordTracker(2000);
    const classifier = createDecisionInjectionClassifier({
      provider: { get: handleGet },
      fallback,
      global: resolveDecisionsConfig({ provider: 'typesafe' }),
      personalities,
      observability: { recordDecisionCall: (r) => records.push(r) },
      tracker,
    });

    const safety: AgentSafety = {
      injection: {
        prelude: INJECTION_DEFENSE_PRELUDE,
        downgradeRejectionMessage: DOWNGRADE_REJECTION_MESSAGE,
        sanitize,
        wrapUntrusted,
        shortPatternCheck,
        c2PatternCheck,
        resolveDowngradedTools,
        classifier,
      },
      redaction: { redactPii, redactString, detectSecrets },
      scopedStorageFactory: (base, scope) =>
        new ScopedStorage(base, { ...scope, alwaysDeny: defaultAlwaysDeny() }),
      approvalPosture: { kind: 'ungated', reason: 'test fixture — no approval policy' },
    };
    const tools = new DefaultToolRegistry();
    tools.register(fetchDoc);
    const loop = new AgentLoop({ llm: scriptedLLM(), tools, personalities, safety });

    const drain = async (personalityId: string, sessionKey: string) => {
      for await (const _ of loop.run('read the doc', { personalityId, sessionKey })) {
        // drain to exhaustion (CLAUDE.md: `done` is not the end of the turn)
      }
    };

    // Consecutive turns, alternating personalities on one loop.
    await drain('plain', 'cli:plain');
    await drain('judge', 'cli:judge');
    await drain('plain', 'cli:plain');
    await tracker.drain();

    // The classifier ran on every turn (content > 500 chars)…
    expect(fallback).toHaveBeenCalledTimes(3);
    for (const [input] of fallback.mock.calls as unknown as Array<[unknown]>) {
      expect(input).toEqual({ content: expect.stringContaining('Release notes.') });
    }
    // …but only `judge`'s turn consulted the provider.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(handleGet).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      expect.objectContaining({
        site: 'injection',
        mode: 'shadow',
        personalityId: 'judge',
        todayVerdict: TODAY,
      }),
    ]);
  });
});
