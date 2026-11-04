// `ethos chat` incognito helpers (plan incognito-sessions §8.2). Kept out of
// commands/chat.ts so the key, wording and fail-open scrub are testable
// without driving the REPL.
import { basename } from 'node:path';
import type { SessionStore } from '@ethosagent/types';
import { isIncognitoSession } from '@ethosagent/wiring';

export const INCOGNITO_PROMPT_TAG = '[incognito]';

export const INCOGNITO_ENTRY_LINE =
  'Incognito: nothing from this session is remembered or learned from. Cleared on /new or after 24 h.';

/** A fresh key in the same `cli:<cwd>:<ts>` shape `/new` rotates to. */
export function incognitoSessionKey(cwd: string = process.cwd(), now: number = Date.now()): string {
  return `cli:${basename(cwd)}:${now}`;
}

/**
 * Blank an incognito session (and its descendants) now. Fail-open: the hourly
 * sweep (lib/incognito-retention.ts) retries, so a locked db must not block
 * `/new` or the process exit. Returns whether a scrub ran.
 */
export async function scrubIncognitoSession(
  store: Pick<SessionStore, 'scrubIncognito'>,
  sessionKey: string,
): Promise<boolean> {
  if (!store.scrubIncognito) return false;
  try {
    await store.scrubIncognito({ sessionKey });
    return true;
  } catch {
    return false;
  }
}

/** `--resume` / `-c`: the stored stamp decides, never the flag (sticky, D6). */
export async function resumedSessionIsIncognito(
  store: Pick<SessionStore, 'getSessionByKey'>,
  sessionKey: string,
): Promise<boolean> {
  const session = await store.getSessionByKey(sessionKey);
  return session ? isIncognitoSession(session) : false;
}

/** `--incognito` with `--resume` / `-c` of a normal session: refused, never run as a remembered chat. */
export const INCOGNITO_RESUME_REFUSAL =
  "--incognito starts a new private session; it can't resume a normal one. Drop --resume/-c, or resume without --incognito.";

/**
 * The refusal text when `--incognito` was passed and the resumed session is
 * NOT itself incognito; null when the combination is allowed (resuming an
 * incognito session, with or without the flag, stays allowed). Enforced at
 * `ethos chat` startup in src/index.ts; pinned by __tests__/chat-incognito.test.ts.
 */
export async function incognitoResumeRefusal(
  store: Pick<SessionStore, 'getSessionByKey'>,
  sessionKey: string,
  incognitoFlag: boolean,
): Promise<string | null> {
  if (!incognitoFlag) return null;
  return (await resumedSessionIsIncognito(store, sessionKey)) ? null : INCOGNITO_RESUME_REFUSAL;
}

/** What every surface says when an incognito scrub could not run (no colour; callers dim it). */
export const INCOGNITO_SCRUB_FAILED_NOTICE =
  '[could not clear the incognito history now; it is cleared within 24 h]';

/**
 * Run `scrub` on `sessionKey`; on `false` hand {@link INCOGNITO_SCRUB_FAILED_NOTICE}
 * to `notify`. Shared by `/new`, `/personality` and the `-q --incognito` exit so
 * none of them drops a failed scrub silently. Pinned by __tests__/chat-incognito.test.ts.
 */
export async function scrubWithNotice(
  scrub: (sessionKey: string) => Promise<boolean>,
  sessionKey: string,
  notify: (line: string) => void,
): Promise<boolean> {
  const ok = await scrub(sessionKey);
  if (!ok) notify(INCOGNITO_SCRUB_FAILED_NOTICE);
  return ok;
}
