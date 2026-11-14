import type { SseEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  type AttentionItem,
  activityToAttentionAction,
  attentionCount,
  attentionReducer,
  emptyAttention,
} from '../attention-state';

function item(
  key: string,
  sessionId = 's1',
  kind: AttentionItem['kind'] = 'approval',
): AttentionItem {
  return { key, kind, sessionId, personalityId: 'p1', detail: 'bash' };
}

describe('attentionReducer', () => {
  it('adds each kind and counts them', () => {
    let s = attentionReducer(emptyAttention, { type: 'add', item: item('approval:a1') });
    s = attentionReducer(s, { type: 'add', item: item('clarify:c1', 's1', 'clarify') });
    s = attentionReducer(s, { type: 'add', item: item('credential:s1:p:k', 's1', 'credential') });
    expect(attentionCount(s)).toBe(3);
  });

  it('dedupes by key', () => {
    const once = attentionReducer(emptyAttention, { type: 'add', item: item('approval:a1') });
    const twice = attentionReducer(once, { type: 'add', item: item('approval:a1') });
    expect(attentionCount(twice)).toBe(1);
    expect(twice).toBe(once);
  });

  it('resolve removes and tombstones', () => {
    const added = attentionReducer(emptyAttention, { type: 'add', item: item('approval:a1') });
    const resolved = attentionReducer(added, { type: 'resolve', key: 'approval:a1' });
    expect(attentionCount(resolved)).toBe(0);
    const replay = attentionReducer(resolved, { type: 'add', item: item('approval:a1') });
    expect(attentionCount(replay)).toBe(0);
  });

  it('resolve of unknown key is a no-op and still tombstones', () => {
    const resolved = attentionReducer(emptyAttention, { type: 'resolve', key: 'approval:zz' });
    expect(attentionCount(resolved)).toBe(0);
    const later = attentionReducer(resolved, { type: 'add', item: item('approval:zz') });
    expect(attentionCount(later)).toBe(0);
  });

  it("view-session clears only that session's items and tombstones them", () => {
    let s = attentionReducer(emptyAttention, { type: 'add', item: item('approval:a1', 's1') });
    s = attentionReducer(s, { type: 'add', item: item('approval:a2', 's2') });
    s = attentionReducer(s, { type: 'view-session', sessionId: 's1' });
    expect(s.items.map((i) => i.key)).toEqual(['approval:a2']);
    s = attentionReducer(s, { type: 'add', item: item('approval:a1', 's1') });
    expect(attentionCount(s)).toBe(1);
  });

  it('dismissed is capped at 200 (oldest forgotten)', () => {
    let s = emptyAttention;
    for (let i = 0; i < 250; i++) {
      s = attentionReducer(s, { type: 'resolve', key: `approval:${i}` });
    }
    expect(s.dismissed).toHaveLength(200);
    expect(s.dismissed).not.toContain('approval:0');
    expect(s.dismissed).toContain('approval:249');
    s = attentionReducer(s, { type: 'add', item: item('approval:0') });
    expect(attentionCount(s)).toBe(1);
  });
});

describe('activityToAttentionAction', () => {
  const env = (event: unknown) => ({
    sessionId: 'sess',
    personalityId: 'pers' as string | null,
    // Test fixture: partial literals standing in for parsed SseEvent values.
    event: event as SseEvent,
  });

  it('maps tool.approval_required to add with the tool name', () => {
    const action = activityToAttentionAction(
      env({
        type: 'tool.approval_required',
        request: {
          approvalId: 'a1',
          sessionId: 'rs',
          toolName: 'bash',
          alwaysAsk: false,
          hardline: false,
        },
      }),
    );
    expect(action).toEqual({
      type: 'add',
      item: {
        key: 'approval:a1',
        kind: 'approval',
        sessionId: 'rs',
        personalityId: 'pers',
        detail: 'bash',
      },
    });
  });

  it('maps approval.resolved to resolve', () => {
    expect(
      activityToAttentionAction(
        env({ type: 'approval.resolved', approvalId: 'a1', decision: 'allow', decidedBy: 'x' }),
      ),
    ).toEqual({ type: 'resolve', key: 'approval:a1' });
  });

  it('maps clarify.request to add without the question text', () => {
    const action = activityToAttentionAction(
      env({ type: 'clarify.request', requestId: 'c1', question: 'SECRET QUESTION' }),
    );
    expect(action).toEqual({
      type: 'add',
      item: {
        key: 'clarify:c1',
        kind: 'clarify',
        sessionId: 'sess',
        personalityId: 'pers',
        detail: 'question',
      },
    });
    expect(JSON.stringify(action)).not.toContain('SECRET QUESTION');
  });

  it('labels a browser takeover clarify', () => {
    const action = activityToAttentionAction(
      env({ type: 'clarify.request', requestId: 'c2', question: 'q', kind: 'browser_takeover' }),
    );
    expect(action?.type === 'add' && action.item.detail).toBe('browser takeover');
  });

  it('maps clarify.resolved to resolve', () => {
    expect(
      activityToAttentionAction(env({ type: 'clarify.resolved', requestId: 'c1', source: 'user' })),
    ).toEqual({ type: 'resolve', key: 'clarify:c1' });
  });

  it('maps credential_required using the label and never the pending message', () => {
    const action = activityToAttentionAction(
      env({
        type: 'credential_required',
        pluginId: 'gh',
        credentialKey: 'token',
        kind: 'api_key',
        label: 'GitHub token',
        pendingUserMessage: 'my private message',
      }),
      7,
    );
    expect(action).toEqual({
      type: 'add',
      item: {
        key: 'credential:sess:gh:token:7',
        kind: 'credential',
        sessionId: 'sess',
        personalityId: 'pers',
        detail: 'GitHub token',
      },
    });
    expect(JSON.stringify(action)).not.toContain('my private message');
  });

  it('returns null for unrelated events', () => {
    expect(activityToAttentionAction(env({ type: 'text_delta', text: 'hi' }))).toBeNull();
    expect(
      activityToAttentionAction(env({ type: 'cron.fired', jobId: 'j', jobName: 'n' })),
    ).toBeNull();
  });
});
