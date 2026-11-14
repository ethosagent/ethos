// Shared /rewind copy and argument parser — one definition for CLI, TUI and web.

export const REWIND_USAGE = 'Usage: /rewind [N] — N prompts back, 1 = your last prompt';
export const REWIND_NOTICE =
  'Rewind starts a new branch from that prompt. Memory writes and tool actions from later turns are not undone.';
export const REWIND_BUSY = 'A turn is running. Stop it first, then rewind.';

export function parseRewindArg(
  arg: string,
): { ok: true; turnsBack: number } | { ok: false; message: string } {
  const t = arg.trim();
  if (t === '') return { ok: true, turnsBack: 1 };
  if (!/^\d+$/.test(t)) return { ok: false, message: REWIND_USAGE };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, message: REWIND_USAGE };
  return { ok: true, turnsBack: n };
}
