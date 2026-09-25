// @vitest-environment jsdom
//
// plan decision-provider-personality §15.1 / §15.8 — the footer's decision
// segment and the decision rows as `Trail` draws them. The strings are the
// approved design's; `observed` never reads as `decided` (K8).

import type { DecisionEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrailAction, TrailEntry } from '../../../lib/trail';
import { StatusLine } from '../StatusLine';
import { Trail } from '../Trail';

function action(id: string, durationMs = 3_100): TrailAction {
  return {
    kind: 'action',
    toolCallId: id,
    toolName: 'read_file',
    args: { path: '/etc/hosts' },
    status: 'ok',
    durationMs,
  };
}

function decision(over: Partial<DecisionEvent> = {}): TrailEntry {
  const event: DecisionEvent = {
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
    model: 'jev-1.13.0',
    personalityId: 'researcher',
    toolCallId: 'a',
    ...over,
  };
  return { kind: 'decision', id: event.id, event };
}

const shadow = { mode: 'shadow' as const, acted: undefined };

function footerText(entries: TrailEntry[]): string {
  const html = renderToStaticMarkup(createElement(Trail, { entries, turnId: 't1' }));
  return html.replace(/<[^>]*>/g, '');
}

describe('Trail footer — decisions', () => {
  it('on: `✓ 2 actions · 3 decisions 118 ms · 6.2s ▸`', () => {
    expect(
      footerText([
        decision({ id: 'r', site: 'router', latencyMs: 41, toolCallId: undefined }),
        action('a'),
        decision({ id: '1', latencyMs: 40 }),
        action('b'),
        decision({ id: '2', latencyMs: 37, toolCallId: 'b' }),
      ]),
    ).toBe('✓ 2 actions · 3 decisions 118 ms · 6.2s▸');
  });

  it('shadow: `3 decisions observed 104 ms · ⚠ 1 disagreement`', () => {
    expect(
      footerText([
        action('a', 4_400),
        decision({ id: '1', ...shadow, latencyMs: 30, disagreed: false }),
        action('b', 4_500),
        decision({ id: '2', ...shadow, latencyMs: 45, disagreed: true, toolCallId: 'b' }),
        decision({ id: '3', ...shadow, latencyMs: 29, disagreed: false, toolCallId: 'b' }),
      ]),
    ).toBe('✓ 2 actions · 3 decisions observed 104 ms · ⚠ 1 disagreement · 8.9s▸');
  });

  it('mixed on + shadow in one turn', () => {
    expect(
      footerText([
        decision({ id: 'r', site: 'router', latencyMs: 41, toolCallId: undefined }),
        action('a'),
        decision({ id: '1', latencyMs: 39 }),
        decision({ id: '2', ...shadow, latencyMs: 38, disagreed: false }),
      ]),
    ).toBe('✓ 1 action · 2 decisions 80 ms · 1 observed 38 ms · 3.1s▸');
  });

  it('decisions and no actions still get a footer — the decision must not vanish', () => {
    expect(
      footerText([decision({ id: 'r', site: 'router', latencyMs: 41, toolCallId: undefined })]),
    ).toBe('1 decision 41 ms▸');
  });

  it('no actions, findings or decisions → no footer', () => {
    expect(footerText([])).toBe('');
  });
});

describe('Trail — decision rows', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function expand(entries: TrailEntry[]): string[] {
    act(() => root.render(createElement(Trail, { entries, turnId: 't1' })));
    act(() => container.querySelector<HTMLButtonElement>('.trail-footer')?.click());
    return Array.from(container.querySelectorAll('.trail-row-wrapper')).map((row) =>
      Array.from(
        row.querySelectorAll(
          '.activity-row-state, .trail-decision-tag, .activity-row-subject, .activity-row-result, .activity-row-meta, .trail-decision-detail',
        ),
      )
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join(' | '),
    );
  }

  it('draws router first, then rows in order, glyph + word + tag + subject + detail + duration', () => {
    const rows = expand([
      decision({
        id: 'r',
        site: 'router',
        verdict: 'trivial',
        confidence: 0.91,
        latencyMs: 41,
        toolCallId: undefined,
      }),
      action('a', 1_200),
      decision({ id: '1' }),
      decision({
        id: '2',
        ...shadow,
        verdict: 'flagged',
        todayVerdict: 'clean',
        disagreed: true,
        latencyMs: 29,
        todayLatencyMs: 1_300,
      }),
    ]);
    expect(rows).toEqual([
      '✓ decided | jev | router · trivial · conf 0.91 | 41 ms | jev-1.13.0',
      '✓ ok | read_file | /etc/hosts | 1.2s',
      '✓ decided | jev | injection · clean · conf 0.94 | 38 ms | jev-1.13.0',
      '⚠ observed | jev | injection · flagged · conf 0.94 | 29 ms vs 1.3s | jev-1.13.0 · LLM check said clean',
    ]);
  });

  it('marks each state with a tone class as well as its words', () => {
    act(() =>
      root.render(
        createElement(Trail, {
          entries: [
            decision({ id: '1', outcome: 'breaker_open', model: undefined, verdict: undefined }),
          ],
          turnId: 't1',
        }),
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('.trail-footer')?.click());
    const row = container.querySelector('.trail-decision');
    expect(row?.className).toContain('trail-decision--failed');
    expect(row?.textContent).toContain('✗ skipped');
    expect(container.textContent).toContain('Jev paused after repeated failures');
  });
});

describe('StatusLine — an on decision holding the loop', () => {
  it('reads the decision label with a steady decision-hued dot', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, {
        phase: 'decision',
        label: 'jev checking read_file result',
        elapsedMs: 0,
        stalled: false,
      }),
    );
    expect(html).toContain('jev checking read_file result');
    expect(html).toContain('status-line-dot--decision');
    expect(html).not.toContain('sb-dot--pulse');
  });
});
