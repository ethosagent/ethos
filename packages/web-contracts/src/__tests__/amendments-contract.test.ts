import type { AmendmentRecord } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from '../index';

// The read-only `amendments` namespace (plan personality-memory-boundary-and-
// self-amendment G2, D30). Zod strips unknown keys, so a field `AmendmentRecord`
// gains and `AmendmentRecordViewSchema` lacks would vanish on the way to the
// browser with nothing thrown. The round trip below is over an object TYPED as
// the real `AmendmentRecord` with every optional field populated: a dropped
// field fails the deep-equal, and a field removed from the type fails typecheck.

function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
  const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
  const schema = def?.[field];
  if (!(schema instanceof z.ZodType)) throw new Error(`contract has no ${field}`);
  return schema;
}

const record: AmendmentRecord = {
  schemaVersion: 1,
  id: 'a-abc-1',
  personalityId: 'researcher',
  target: 'toolset',
  ops: [{ op: 'add_tool', tool: 'web_fetch' }],
  opsHash: 'o'.repeat(64),
  baseHash: 'b'.repeat(64),
  rationale: 'fetches keep failing <b>',
  evidence: [
    {
      sessionId: 's-1',
      toolCallId: 'tc-1',
      toolName: 'web_fetch',
      messageId: 'm-1',
      excerpt: 'not in toolset',
    },
  ],
  provenance: {
    sessionId: 's-1',
    sessionKey: 'web:abc',
    platform: 'web',
    origin: 'web',
    initiator: 'user',
    roomAudience: 'private',
    turn: 3,
    traceId: 't-1',
    executionPosture: 'local',
    holdsShellTool: true,
  },
  preCheck: 'ok',
  status: 'applied',
  history: [
    { action: 'filed', actor: 'intake', at: '2026-09-28T00:00:00.000Z' },
    {
      action: 'approve',
      actor: 'cli',
      decidedBy: 'cli:owner',
      at: '2026-09-28T00:01:00.000Z',
      reason: 'ok',
    },
  ],
  applied: { appliedHash: 'a'.repeat(64), at: '2026-09-28T00:01:00.000Z' },
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:01:00.000Z',
};

describe('amendments contract', () => {
  it('is read-only: list and get, nothing else', () => {
    expect(Object.keys(contract.amendments).sort()).toEqual(['get', 'list']);
  });

  it('round-trips a fully populated AmendmentRecord through list', () => {
    const out = schemaOf(contract.amendments.list, 'outputSchema');
    expect(out.parse({ amendments: [record] })).toEqual({ amendments: [record] });
  });

  it('round-trips a review, including a constitution pre-check refusal', () => {
    const review = {
      record: { ...record, status: 'auto_rejected', preCheck: { reason: 'forbidden tool' } },
      personality: 'ok',
      liveHash: 'l'.repeat(64),
      stale: false,
      interruptedApply: false,
      opsProblem: 'web_fetch is already in the toolset',
      expectedAfterHash: null,
      textDiff: [' - read_file', '+- web_fetch'],
      permissionDiff: {
        changes: [
          {
            section: 'Toolset',
            field: 'toolset',
            direction: 'widens',
            detail: '+ web_fetch',
            flag: 'high-risk',
          },
        ],
        widens: true,
      },
      notCompared: 'Not compared: SOUL.md',
      flags: ['local-terminal', 'high-risk'],
    };
    const out = schemaOf(contract.amendments.get, 'outputSchema');
    expect(out.parse({ review })).toEqual({ review });
  });
});
