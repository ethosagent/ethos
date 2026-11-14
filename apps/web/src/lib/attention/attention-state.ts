import type { SseEvent } from '@ethosagent/web-contracts';

// Pure state for "this chat needs the user" signals (pending approval,
// clarify question, credential request). No DOM. The hook feeds it
// from SSE and applies title/favicon/notification from the count.

export type AttentionKind = 'approval' | 'clarify' | 'credential';

export interface AttentionItem {
  /** 'approval:<approvalId>' | 'clarify:<requestId>' | 'credential:<sessionId>:<pluginId>:<credentialKey>' */
  key: string;
  kind: AttentionKind;
  sessionId: string;
  personalityId: string | null;
  /** Safe label only: toolName | 'question' | plugin label. Never args/question/message text. */
  detail: string;
}

export interface AttentionState {
  items: readonly AttentionItem[];
  /** Tombstones: keys resolved or viewed, so a replayed SSE event cannot resurrect them. */
  dismissed: readonly string[];
}

const DISMISSED_CAP = 200;

export const emptyAttention: AttentionState = { items: [], dismissed: [] };

export type AttentionAction =
  | { type: 'add'; item: AttentionItem }
  | { type: 'resolve'; key: string }
  | { type: 'view-session'; sessionId: string };

function tombstone(dismissed: readonly string[], keys: readonly string[]): readonly string[] {
  const fresh = keys.filter((k) => !dismissed.includes(k));
  if (fresh.length === 0) return dismissed;
  const next = [...dismissed, ...fresh];
  return next.length > DISMISSED_CAP ? next.slice(next.length - DISMISSED_CAP) : next;
}

export function attentionReducer(state: AttentionState, action: AttentionAction): AttentionState {
  switch (action.type) {
    case 'add': {
      const { key } = action.item;
      if (state.dismissed.includes(key) || state.items.some((i) => i.key === key)) return state;
      return { ...state, items: [...state.items, action.item] };
    }
    case 'resolve': {
      const dismissed = tombstone(state.dismissed, [action.key]);
      const items = state.items.filter((i) => i.key !== action.key);
      if (dismissed === state.dismissed && items.length === state.items.length) return state;
      return { items, dismissed };
    }
    case 'view-session': {
      const cleared = state.items.filter((i) => i.sessionId === action.sessionId);
      if (cleared.length === 0) return state;
      return {
        items: state.items.filter((i) => i.sessionId !== action.sessionId),
        dismissed: tombstone(
          state.dismissed,
          cleared.map((i) => i.key),
        ),
      };
    }
  }
}

export function attentionCount(state: AttentionState): number {
  return state.items.length;
}

/**
 * Map one activity envelope to a reducer action. `credential_required` has no
 * `sessionId` field, so the session comes from the envelope (the hook builds
 * one from the active session subscription).
 */
export function activityToAttentionAction(envelope: {
  sessionId: string;
  personalityId: string | null;
  event: SseEvent;
}): AttentionAction | null {
  const { sessionId, personalityId, event } = envelope;
  switch (event.type) {
    case 'tool.approval_required':
      return {
        type: 'add',
        item: {
          key: `approval:${event.request.approvalId}`,
          kind: 'approval',
          sessionId: event.request.sessionId,
          personalityId,
          detail: event.request.toolName,
        },
      };
    case 'approval.resolved':
      return { type: 'resolve', key: `approval:${event.approvalId}` };
    case 'clarify.request':
      return {
        type: 'add',
        item: {
          key: `clarify:${event.requestId}`,
          kind: 'clarify',
          sessionId,
          personalityId,
          detail: event.kind === 'browser_takeover' ? 'browser takeover' : 'question',
        },
      };
    case 'clarify.resolved':
      return { type: 'resolve', key: `clarify:${event.requestId}` };
    case 'credential_required':
      return {
        type: 'add',
        item: {
          key: `credential:${sessionId}:${event.pluginId}:${event.credentialKey}`,
          kind: 'credential',
          sessionId,
          personalityId,
          detail: event.label,
        },
      };
    default:
      return null;
  }
}
