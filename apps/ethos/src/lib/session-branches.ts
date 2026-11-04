import { basename } from 'node:path';
import { formatBranchList, pickBranch } from '@ethosagent/surface-kit';
import type { SessionStore } from '@ethosagent/types';
import { forkSession, forkSessionKey, isIncognitoSession, listBranches } from '@ethosagent/wiring';

/** Shown when an incognito session is asked to switch onto a normal branch. */
export const NOT_INCOGNITO_BRANCH_MESSAGE =
  'That branch is not incognito. Send /new to leave incognito first.';

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
  // Fail closed: the caller's incognito flag follows a switch, so the next turn
  // would stamp a normal branch incognito (and `/new` or the sweep would wipe it).
  if (isIncognitoSession(current) && !isIncognitoSession(picked.session)) {
    return { message: NOT_INCOGNITO_BRANCH_MESSAGE };
  }
  return {
    message: `Switched to branch ${picked.n}.`,
    switchTo: {
      sessionKey: picked.session.key,
      ...(picked.session.personalityId ? { personalityId: picked.session.personalityId } : {}),
    },
  };
}
