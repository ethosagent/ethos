import { describe, expect, it, vi } from 'vitest';
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from '../blocks/approval';
import { handleApprovalAction } from '../interactions/actions';

function payload(overrides = {}) {
  return {
    actionId: APPROVE_ACTION_ID,
    approvalId: 'a1',
    userId: 'U1',
    channelId: 'C1',
    messageTs: '1700000000.1',
    ...overrides,
  };
}
describe('interactions/actions — handleApprovalAction', () => {
  it('routes an Allow click to the decision callback as allow', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    await handleApprovalAction(payload({ actionId: APPROVE_ACTION_ID }), { onDecision });
    expect(onDecision).toHaveBeenCalledWith({
      approvalId: 'a1',
      decision: 'allow',
      decidedBy: 'U1',
      channelId: 'C1',
      messageTs: '1700000000.1',
    });
  });
  it('routes a Deny click to the decision callback as deny', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    await handleApprovalAction(payload({ actionId: DENY_ACTION_ID }), { onDecision });
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'a1', decision: 'deny', decidedBy: 'U1' }),
    );
  });
  it('ignores action ids it does not own', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    await handleApprovalAction(payload({ actionId: 'some_other_button' }), { onDecision });
    expect(onDecision).not.toHaveBeenCalled();
  });
  it('ignores a click with an empty approvalId', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    await handleApprovalAction(payload({ approvalId: '' }), { onDecision });
    expect(onDecision).not.toHaveBeenCalled();
  });
  it('ignores a click with no identifiable user — authorization must fail closed', async () => {
    // A malformed interaction payload (`body.user?.id` absent) yields an
    // empty userId. An anonymous decider must never resolve a dangerous tool
    // approval.
    const onDecision = vi.fn().mockResolvedValue(undefined);
    await handleApprovalAction(payload({ userId: '' }), { onDecision });
    expect(onDecision).not.toHaveBeenCalled();
  });
  it('swallows callback errors so a stale click never crashes the adapter', async () => {
    const onDecision = vi.fn().mockRejectedValue(new Error('already resolved'));
    await expect(handleApprovalAction(payload(), { onDecision })).resolves.toBeUndefined();
  });
});
