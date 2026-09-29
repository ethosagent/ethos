// plan personality-memory-boundary G2 — the `propose_self_amendment` tool's own
// half: argument shape and bounds, and that it holds only a filing port. The
// intake's refusal matrix is packages/wiring/src/__tests__/propose-amendment.test.ts.

import type { AmendmentSubmitPort, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createProposeSelfAmendmentTool, PROPOSE_SELF_AMENDMENT_TOOL } from '../propose-amendment';

const ctx = { sessionId: 's', sessionKey: 'cli:x', platform: 'cli' } as ToolContext;

function portReturning(result: Awaited<ReturnType<AmendmentSubmitPort['submit']>>) {
  const submit = vi.fn(async () => result);
  return { port: { submit } satisfies AmendmentSubmitPort, submit };
}

const OK_ARGS = { ops: [{ op: 'add_tool', tool: 'web_fetch' }], rationale: 'fetches were refused' };

describe('propose_self_amendment tool', () => {
  it('is named, toolset-labelled and schema-bound as the plan says', () => {
    const tool = createProposeSelfAmendmentTool(portReturning({ ok: false, reason: 'x' }).port);
    expect(tool.name).toBe(PROPOSE_SELF_AMENDMENT_TOOL);
    expect(tool.toolset).toBe('self_amendment');
    expect(tool.capabilities).toEqual({});
    expect(tool.alwaysInclude).toBeUndefined();
    const props = (tool.schema as { properties: Record<string, unknown> }).properties;
    // No argument names a personality: the intake files for ctx.personalityId
    // only (G2-2). `target` names which of its OWN files (toolset or identity).
    expect(Object.keys(props).sort()).toEqual([
      'evidence_tool_call_ids',
      'ops',
      'rationale',
      'target',
    ]);
    expect((props.target as { enum: string[] }).enum).toEqual(['toolset', 'identity']);
  });

  it('passes identity ops through as shape only, and refuses a toolset op under target identity', async () => {
    const { port, submit } = portReturning({
      ok: true,
      id: 'a-2',
      status: 'pending',
      deduped: false,
    });
    const tool = createProposeSelfAmendmentTool(port);
    await tool.execute(
      {
        target: 'identity',
        ops: [{ op: 'set_display_emoji', value: '🦉' }],
        rationale: 'the operator chose it',
      },
      ctx,
    );
    expect(submit).toHaveBeenCalledWith(
      {
        target: 'identity',
        ops: [{ op: 'set_display_emoji', value: '🦉' }],
        rationale: 'the operator chose it',
      },
      ctx,
    );
    expect(
      await tool.execute(
        { target: 'identity', ops: [{ op: 'add_tool', tool: 'x' }], rationale: 'r' },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(
      await tool.execute(
        { target: 'soul', ops: [{ op: 'add_tool', tool: 'x' }], rationale: 'r' },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: 'input_invalid' });
  });

  it('is unavailable with no port wired', async () => {
    const tool = createProposeSelfAmendmentTool(undefined);
    expect(tool.isAvailable?.()).toBe(false);
    expect(await tool.execute(OK_ARGS, ctx)).toMatchObject({ ok: false, code: 'not_available' });
  });

  it('passes structured ops, rationale and evidence ids to the port with the turn context', async () => {
    const { port, submit } = portReturning({
      ok: true,
      id: 'a-1',
      status: 'pending',
      deduped: false,
    });
    const tool = createProposeSelfAmendmentTool(port);
    const result = await tool.execute({ ...OK_ARGS, evidence_tool_call_ids: ['c1'] }, ctx);
    expect(submit).toHaveBeenCalledWith(
      {
        target: 'toolset',
        ops: [{ op: 'add_tool', tool: 'web_fetch' }],
        rationale: 'fetches were refused',
        evidenceToolCallIds: ['c1'],
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, value: expect.stringContaining('a-1') });
  });

  it('reports a refusal, a dedupe and an auto-rejection in plain text', async () => {
    const refused = createProposeSelfAmendmentTool(
      portReturning({ ok: false, reason: 'from a fresh session' }).port,
    );
    expect(await refused.execute(OK_ARGS, ctx)).toMatchObject({
      ok: false,
      error: 'Not filed: from a fresh session',
    });
    const deduped = createProposeSelfAmendmentTool(
      portReturning({ ok: true, id: 'a-2', status: 'pending', deduped: true }).port,
    );
    expect(await deduped.execute(OK_ARGS, ctx)).toMatchObject({
      ok: true,
      value: expect.stringMatching(/already pending as a-2/),
    });
    const rejected = createProposeSelfAmendmentTool(
      portReturning({
        ok: true,
        id: 'a-3',
        status: 'auto_rejected',
        deduped: false,
        reason: 'declares forbidden tool',
      }).port,
    );
    expect(await rejected.execute(OK_ARGS, ctx)).toMatchObject({
      ok: true,
      value: expect.stringMatching(/rejected automatically.*forbidden tool/),
    });
  });

  const bad: Array<[string, unknown]> = [
    ['no ops', { rationale: 'r' }],
    ['empty ops', { ops: [], rationale: 'r' }],
    [
      'more than 10 ops',
      {
        ops: Array.from({ length: 11 }, (_, i) => ({ op: 'add_tool', tool: `t${i}` })),
        rationale: 'r',
      },
    ],
    ['an unknown op', { ops: [{ op: 'set_model', tool: 'x' }], rationale: 'r' }],
    ['an op with no tool', { ops: [{ op: 'add_tool' }], rationale: 'r' }],
    ['no rationale', { ops: OK_ARGS.ops }],
    ['a rationale over 1000 chars', { ops: OK_ARGS.ops, rationale: 'x'.repeat(1001) }],
    ['evidence that is not strings', { ...OK_ARGS, evidence_tool_call_ids: [1] }],
    ['more than 10 evidence ids', { ...OK_ARGS, evidence_tool_call_ids: Array(11).fill('c') }],
  ];

  it.each(bad)('refuses %s before reaching the port', async (_label, args) => {
    const { port, submit } = portReturning({
      ok: true,
      id: 'a',
      status: 'pending',
      deduped: false,
    });
    const result = await createProposeSelfAmendmentTool(port).execute(args, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(submit).not.toHaveBeenCalled();
  });
});
