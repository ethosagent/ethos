// V5-1 — the pre-LLM gate reserved 4,096 output tokens unless the turn set
// `maxCompletionTokens`, while `AnthropicProvider` sends the model's full
// output cap (64K on Haiku 4.5, 128K on the 1M models). On Haiku 4.5 a history
// of ~157K passed the 0.8 gate, and 157K + 64K is over the 200K window. The
// gate now reserves the cap the provider reports in `capabilities.maxOutputTokens`
// (bounded, as every reserve is, by half the window), so the history the gate
// admits plus the output the provider requests fits the window.

import type { LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  evaluateGate,
  gateThreshold,
  pressureGateTokens,
} from '../agent-loop/compaction';

type GateLLM = Pick<LLMProvider, 'maxContextTokens' | 'capabilities'>;

const haiku: GateLLM = {
  maxContextTokens: 200_000,
  capabilities: { streaming: true, toolCalling: true, maxOutputTokens: 64_000 },
};

describe('the gate reserves the provider-reported output cap', () => {
  it('Haiku 4.5: 200K window minus the 64K cap', () => {
    const g = evaluateGate({ llm: haiku }, [], '');
    expect(g.window).toBe(136_000);
  });

  it('history at the 0.8 gate plus the full cap fits the window', () => {
    const g = evaluateGate({ llm: haiku }, [], '');
    expect(gateThreshold(g, 0.8) + 64_000).toBeLessThanOrEqual(200_000);
    // The ~157K history that overflowed before is now over the gate.
    expect(gateThreshold(g, 0.8)).toBeLessThan(157_000);
  });

  it('a per-turn reservedOutputTokens (maxCompletionTokens) still wins', () => {
    const g = evaluateGate({ llm: haiku, reservedOutputTokens: 1_000 }, [], '');
    expect(g.window).toBe(199_000);
  });

  it('a cap above half the window is bounded at half the window', () => {
    const small: GateLLM = {
      maxContextTokens: 100_000,
      capabilities: { streaming: true, toolCalling: true, maxOutputTokens: 128_000 },
    };
    expect(evaluateGate({ llm: small }, [], '').window).toBe(50_000);
  });

  it('a provider that reports no cap keeps the 4,096 default', () => {
    const g = evaluateGate({ llm: { maxContextTokens: 200_000 } }, [], '');
    expect(g.window).toBe(200_000 - DEFAULT_OUTPUT_RESERVE_TOKENS);
  });

  it('pressureGateTokens takes the same reserve, so a server trigger matches the gate', () => {
    expect(pressureGateTokens(200_000, undefined, undefined, 64_000)).toBe(
      gateThreshold(evaluateGate({ llm: haiku }, [], ''), 0.8),
    );
    expect(pressureGateTokens(200_000)).toBe(
      gateThreshold(evaluateGate({ llm: { maxContextTokens: 200_000 } }, [], ''), 0.8),
    );
  });
});
