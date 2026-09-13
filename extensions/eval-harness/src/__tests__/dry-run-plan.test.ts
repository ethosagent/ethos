// X-D12 — `collectDryRunPlan` reads the loop's own `dry_run_summary.plan`, and
// `toolCalledScorer` grades against it.

import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { collectDryRunPlan, toolCalledScorer } from '../dry-run-plan';

const EXPECTED = (tool: string) => ({ id: 'case', expected: tool });

describe('collectDryRunPlan', () => {
  it('reads dry_run_summary.plan, not tool_start events', () => {
    const events: AgentEvent[] = [
      // A tool_start for a call that is NOT in the plan — e.g. an in-script
      // inner call. Reading tool_start would put it in the plan.
      { type: 'tool_start', toolCallId: 'inner#1', toolName: 'from_tool_start', args: {} },
      { type: 'text_delta', text: 'thinking about it' },
      { type: 'done', text: 'thinking about it', turnCount: 1 },
      {
        type: 'dry_run_summary',
        plan: [
          { toolCallId: 'c1', toolName: 'web_search', args: { q: 'x' } },
          { toolCallId: 'c2', toolName: 'send_message', args: {} },
        ],
        capped: 0,
      },
    ];
    expect(collectDryRunPlan(events)).toEqual([
      { toolCallId: 'c1', toolName: 'web_search', args: { q: 'x' } },
      { toolCallId: 'c2', toolName: 'send_message', args: {} },
    ]);
  });

  it('is empty when the turn planned nothing (no summary event)', () => {
    const events: AgentEvent[] = [
      { type: 'tool_start', toolCallId: 'c1', toolName: 'web_search', args: {} },
      { type: 'done', text: '', turnCount: 1 },
    ];
    expect(collectDryRunPlan(events)).toEqual([]);
  });
});

describe('toolCalledScorer', () => {
  const plan = [{ toolCallId: 'c1', toolName: 'web_search', args: {} }];

  it('called: 1 when the tool is planned, 0 when it is not', async () => {
    expect(await toolCalledScorer(plan)('', EXPECTED('web_search'))).toBe(1);
    expect(await toolCalledScorer(plan)('', EXPECTED('send_message'))).toBe(0);
  });

  it('not_called: the inverse', async () => {
    expect(await toolCalledScorer(plan, 'not_called')('', EXPECTED('web_search'))).toBe(0);
    expect(await toolCalledScorer(plan, 'not_called')('', EXPECTED('send_message'))).toBe(1);
  });

  it('ignores the response text — a tool named in prose is not a call', async () => {
    expect(await toolCalledScorer([])('I will call send_message', EXPECTED('send_message'))).toBe(
      0,
    );
  });
});
