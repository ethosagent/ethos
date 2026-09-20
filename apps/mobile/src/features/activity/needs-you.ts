import type { ApprovalRequest, SseEvent } from '@ethosagent/web-contracts';

// "Needs you N" — the Activity badge and the pinned group. Off the Activity
// tab nothing holds `/sse/activity` open (R6a): the count is
// `tools.listPending` (on focus and foreground) kept current by the session
// stream's approval frames, plus the open session's questions.

export const NEEDS_YOU_KEY = ['needs-you'] as const;

/** Fold one session-stream frame into the cached pending list. */
export function foldPending(list: readonly ApprovalRequest[], event: SseEvent): ApprovalRequest[] {
  if (event.type === 'approval.resolved')
    return list.filter((a) => a.approvalId !== event.approvalId);
  if (event.type === 'tool.approval_required') {
    return list.some((a) => a.approvalId === event.request.approvalId)
      ? [...list]
      : [...list, event.request];
  }
  return [...list];
}

export function needsYouCount(approvals: readonly ApprovalRequest[], questions: number): number {
  return approvals.length + questions;
}
