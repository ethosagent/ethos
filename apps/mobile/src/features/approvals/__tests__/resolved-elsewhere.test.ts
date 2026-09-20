import { initialChatState } from '@ethosagent/chat-state';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../../../state/chat-store';
import { reconcileApprovals } from '../reconcile';

function approval(id: string, toolName = 'bash'): ApprovalRequest {
  return {
    approvalId: id,
    sessionId: 's1',
    toolCallId: `tc-${id}`,
    toolName,
    args: {},
    reason: null,
  };
}

describe('reconcileApprovals', () => {
  beforeEach(() => {
    useChatStore.getState().reset('s1');
  });

  it('an approval decided while the phone was away drops out and leaves a row', () => {
    const r = reconcileApprovals([approval('a1')], [], Date.parse('2026-09-19T09:41:00'));
    expect(r.pending).toEqual([]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]).toMatchObject({
      glyph: '·',
      word: 'resolved',
      subject: 'bash',
      result: 'elsewhere',
    });
    expect(r.resolved[0]?.time).toMatch(/^\d\d:\d\d$/);
  });

  it('the server list is the truth — held ones stay, missed ones are added', () => {
    const r = reconcileApprovals([approval('a1')], [approval('a1'), approval('a2', 'git')], 0);
    expect(r.pending.map((a) => a.approvalId)).toEqual(['a1', 'a2']);
    expect(r.resolved).toEqual([]);
  });

  it('the store drops the panel and appends the row (no panel is shown)', () => {
    useChatStore.setState({
      chat: { ...initialChatState, pendingApprovals: [approval('a1')] },
    });
    useChatStore.getState().reconcile([]);
    expect(useChatStore.getState().chat.pendingApprovals).toEqual([]);
    const notices = useChatStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ word: 'resolved', subject: 'bash' });
  });

  it('reset clears notices', () => {
    useChatStore.setState({
      chat: { ...initialChatState, pendingApprovals: [approval('a1')] },
    });
    useChatStore.getState().reconcile([]);
    useChatStore.getState().reset('s2');
    expect(useChatStore.getState().notices).toEqual([]);
    expect(useChatStore.getState().sessionId).toBe('s2');
  });
});
