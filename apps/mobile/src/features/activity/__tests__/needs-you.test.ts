import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { foldPending, needsYouCount } from '../needs-you';

const approval = (id: string): ApprovalRequest => ({
  approvalId: id,
  sessionId: 's1',
  toolCallId: `tc-${id}`,
  toolName: 'bash',
  args: { command: 'ls' },
  reason: null,
});

describe('needs-you', () => {
  it('two approvals and one question read 3', () => {
    expect(needsYouCount([approval('a1'), approval('a2')], 1)).toBe(3);
  });

  it('an approval.resolved frame takes it to 2', () => {
    const next = foldPending([approval('a1'), approval('a2')], {
      type: 'approval.resolved',
      approvalId: 'a1',
      decision: 'allow',
      decidedBy: 'web-1',
    });
    expect(next.map((a) => a.approvalId)).toEqual(['a2']);
    expect(needsYouCount(next, 1)).toBe(2);
  });

  it('a new request is added once, even when replayed', () => {
    const event = { type: 'tool.approval_required', request: approval('a3') } as const;
    const first = foldPending([approval('a1')], event);
    expect(first.map((a) => a.approvalId)).toEqual(['a1', 'a3']);
    const second = foldPending(first, event);
    expect(second.map((a) => a.approvalId)).toEqual(['a1', 'a3']);
  });

  it('other frames leave the list alone but never return the same array', () => {
    const list = [approval('a1')];
    const out = foldPending(list, { type: 'text_delta', text: 'hi' });
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });
});
