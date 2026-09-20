import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { clock, type RowData } from '../../lib/row';

/**
 * Fold the server's pending list (`tools.listPending`, read on foreground) into
 * what the phone held from before it was backgrounded. The server is the truth:
 * a request it still holds stays or is added, one it no longer holds was decided
 * while the phone was away — another client, the lock screen, or the timeout —
 * and resolves in place as a row instead of a live panel (D7). `listPending`
 * does not say HOW it was decided, so the row does not either.
 */
export function reconcileApprovals(
  held: readonly ApprovalRequest[],
  server: readonly ApprovalRequest[],
  now: number,
): { pending: ApprovalRequest[]; resolved: RowData[] } {
  const live = new Set(server.map((a) => a.approvalId));
  return {
    pending: [...server],
    resolved: held
      .filter((a) => !live.has(a.approvalId))
      .map((a) => ({
        glyph: '·',
        word: 'resolved',
        subject: a.toolName,
        result: 'elsewhere',
        time: clock(now),
      })),
  };
}
