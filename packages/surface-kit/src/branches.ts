// Session-branch rendering shared by every surface that offers `/branches` and
// `/branch <n>` (CLI readline, TUI, gateway). The branch list itself comes from
// `listBranches` in packages/core/src/session-fork.ts; this file only numbers
// and renders it, so the numbers a user reads are the numbers `/branch` takes.

import type { Session } from '@ethosagent/types';

export const BRANCH_USAGE = 'Usage: /branch <n> — pick a number from /branches';

/** Render a `listBranches` result, 1-based, marking the current session. */
export function formatBranchList(branches: readonly Session[], currentId: string): string {
  if (branches.length <= 1) return 'No branches yet. /fork starts one from this session.';
  const lines = branches.map((s, i) => {
    const marker = s.id === currentId ? '*' : ' ';
    const label = i === 0 ? 'origin' : 'fork';
    const title = s.title ? ` "${s.title}"` : '';
    return `${marker} ${i + 1}. ${label}${title} — ${s.key}`;
  });
  return `Branches:\n${lines.join('\n')}\n/branch <n> to switch.`;
}

/**
 * Resolve the `/branch` argument against the list `formatBranchList` numbered.
 * Anything that is not an in-range whole number is refused with usage text.
 */
export function pickBranch(
  arg: string,
  branches: readonly Session[],
): { ok: true; session: Session; n: number } | { ok: false; message: string } {
  const trimmed = arg.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const session = Number.isInteger(n) && n >= 1 ? branches[n - 1] : undefined;
  if (!session) {
    const range = branches.length > 0 ? ` (1-${branches.length})` : '';
    return { ok: false, message: `${BRANCH_USAGE}${range}` };
  }
  return { ok: true, session, n };
}
