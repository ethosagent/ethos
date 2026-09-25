import { basename } from 'node:path';
import { formatBranchList, pickBranch } from '@ethosagent/surface-kit';
import type { SessionStore } from '@ethosagent/types';
import { forkSession, forkSessionKey, listBranches } from '@ethosagent/wiring';

export type BranchCommand = 'fork' | 'branches' | 'branch';

export interface BranchOutcome {
  /** One line (or a list) to show the user. */
  message: string;
  /** Present when the REPL must re-key onto this session. */
  switchTo?: { sessionKey: string; personalityId?: string };
}

/**
 * `/fork`, `/branches`, `/branch <n>` for the CLI readline REPL and the TUI —
 * one implementation so both number branches identically. Forking goes through
 * `forkSession` and listing through `listBranches` (packages/core/src/session-fork.ts);
 * the fork key follows the CLI convention `cli:<cwd>:fork:<ts>-<suffix>` (`forkSessionKey`).
 */
export async function runBranchCommand(
  store: SessionStore,
  command: BranchCommand,
  arg: string,
  currentSessionKey: string,
  cwd: string = process.cwd(),
): Promise<BranchOutcome> {
  const current = await store.getSessionByKey(currentSessionKey);
  if (!current) return { message: 'Nothing to branch yet — send a message first.' };

  if (command === 'fork') {
    const { session } = await forkSession(store, current.id, {
      key: forkSessionKey(`cli:${basename(cwd)}`),
    });
    return {
      message: 'Forked — now on a new branch. /branches lists them, /branch <n> switches.',
      switchTo: {
        sessionKey: session.key,
        ...(session.personalityId ? { personalityId: session.personalityId } : {}),
      },
    };
  }

  const branches = await listBranches(store, current.id);
  if (command === 'branches') return { message: formatBranchList(branches, current.id) };

  const picked = pickBranch(arg, branches);
  if (!picked.ok) return { message: picked.message };
  if (picked.session.id === current.id) return { message: `Already on branch ${picked.n}.` };
  return {
    message: `Switched to branch ${picked.n}.`,
    switchTo: {
      sessionKey: picked.session.key,
      ...(picked.session.personalityId ? { personalityId: picked.session.personalityId } : {}),
    },
  };
}
