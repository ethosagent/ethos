// Query keys for the personality approval outbox (plan
// `trust-before-reach.md` Part 2, O-T10).
//
// One key per SCOPE, shared by the pane and by the breadcrumb's NeedsYouPill,
// so a decision made in the pane refreshes the count in the chrome without a
// second poll — the same arrangement `kanbanKeys.board` already has.

export type OutboxScope = { personalityId: string } | { teamId: string } | Record<string, never>;

export const outboxKeys = {
  all: () => ['outbox'] as const,
  list: (scope: OutboxScope) => [...outboxKeys.all(), 'list', scope] as const,
};
