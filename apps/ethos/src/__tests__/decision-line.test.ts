import type { AgentEvent } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { decisionLine, decisionLineText } from '../lib/decision-line';
import { projectEvent } from '../lib/verbosity';

// plan decision-provider-personality §15.6 — one compact line per settled
// decision in CLI chat, glyph + word always, gated like `tool_end`.

type DecisionEvent = Extract<AgentEvent, { type: 'decision' }>;

function decision(over: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    type: 'decision',
    id: 'd1',
    phase: 'settled',
    site: 'injection',
    provider: 'typesafe',
    mode: 'on',
    outcome: 'ok',
    acted: true,
    verdict: 'clean',
    confidence: 0.94,
    latencyMs: 38,
    personalityId: 'researcher',
    toolCallId: 'tc1',
    ...over,
  };
}

function text(e: DecisionEvent): string | null {
  const line = decisionLine(e);
  return line ? decisionLineText(line) : null;
}

const shadow = { mode: 'shadow' as const, acted: undefined };

describe('decisionLine', () => {
  it('decided', () => {
    expect(
      text(decision({ site: 'router', verdict: 'trivial', confidence: 0.91, latencyMs: 41 })),
    ).toBe('✓ decided jev router · trivial 0.91 · 41 ms');
  });

  it('unsure falls back, naming where to', () => {
    expect(
      text(decision({ acted: false, verdict: undefined, confidence: 0.41, latencyMs: 1200 })),
    ).toBe('⚠ unsure jev injection · 0.41 · 1.2s → LLM check');
    expect(text(decision({ site: 'router', acted: false, verdict: undefined }))).toContain(
      '→ default model',
    );
  });

  it('observed, agreed — with the comparison only when today was measured', () => {
    expect(
      text(decision({ ...shadow, disagreed: false, latencyMs: 36, todayLatencyMs: 1400 })),
    ).toBe('✓ observed jev injection · clean · agreed · 36 ms vs 1.4s');
    expect(text(decision({ ...shadow, disagreed: false, latencyMs: 36 }))).toBe(
      '✓ observed jev injection · clean · agreed · 36 ms',
    );
  });

  it('observed, disagreed', () => {
    expect(
      text(
        decision({
          ...shadow,
          verdict: 'flagged',
          todayVerdict: 'clean',
          disagreed: true,
          latencyMs: 29,
          todayLatencyMs: 1300,
        }),
      ),
    ).toBe('⚠ observed jev injection · flagged · LLM said clean · 29 ms vs 1.3s');
  });

  it('unavailable: on falls back, shadow does not', () => {
    const failed = decision({ outcome: 'timeout', acted: false, verdict: undefined });
    expect(text(failed)).toBe('✗ unavailable jev injection · timeout → LLM check');
    expect(text({ ...failed, ...shadow })).toBe('✗ unavailable jev injection · timeout');
  });

  it('skipped: breaker open', () => {
    expect(text(decision({ outcome: 'breaker_open', acted: false, verdict: undefined }))).toBe(
      '✗ skipped jev injection · paused after repeated failures',
    );
  });

  it('a started decision has no line', () => {
    expect(text(decision({ phase: 'started', outcome: undefined }))).toBeNull();
  });
});

describe('projectEvent — decision', () => {
  it('shows the line at default, verbose and debug; hides it in quiet', () => {
    const e = decision();
    for (const level of ['default', 'verbose', 'debug'] as const) {
      expect(projectEvent(e, level).filter((l) => l.kind === 'decision')).toEqual([
        { kind: 'decision', text: '✓ decided jev injection · clean 0.94 · 38 ms' },
      ]);
    }
    expect(projectEvent(e, 'quiet')).toEqual([]);
  });

  it('renders nothing for a started decision (no status slot in the CLI)', () => {
    expect(projectEvent(decision({ phase: 'started' }), 'default')).toEqual([]);
  });
});
