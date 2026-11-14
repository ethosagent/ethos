// Deny-and-redirect note handling shared by every approval surface.
// The note is user-authored but untrusted bytes: hidden and control characters
// are stripped and length is capped. Pinned by `__tests__/approval-note.test.ts`.

import { APPROVAL_NOTE_MAX_CHARS } from '@ethosagent/types';
import { isHiddenCodePoint } from './hidden-chars';

/**
 * Normalize a deny note. Returns `undefined` when nothing visible remains
 * (the caller then treats the decision as a plain deny).
 */
export function sanitizeApprovalNote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let out = '';
  for (const ch of raw.replace(/\r\n/g, '\n')) {
    if (ch === '\t') {
      out += ' ';
      continue;
    }
    const cp = ch.codePointAt(0) as number;
    if (cp !== 0x0a && isHiddenCodePoint(cp)) continue;
    out += ch;
  }
  const trimmed = out.trim();
  if (trimmed === '') return undefined;
  const points = Array.from(trimmed);
  if (points.length <= APPROVAL_NOTE_MAX_CHARS) return trimmed;
  return `${points.slice(0, APPROVAL_NOTE_MAX_CHARS - 1).join('')}…`;
}

/** Tool-result text for a denied approval; appends the user's instruction when given. */
export function formatApprovalDenial(input: {
  reason: string;
  dangerReason: string;
  note?: string;
}): string {
  const base = `${input.reason} — ${input.dangerReason}`;
  if (!input.note) return base;
  return `${base}\nThe user did not allow this call and said what to do instead: ${input.note}`;
}
