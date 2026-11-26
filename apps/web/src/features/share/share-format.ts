import type { ShareExpiry, ShareRefusal } from '@ethosagent/web-contracts';
import { formatBytes } from '../../lib/attachments';

export const EXPIRY_OPTIONS: ReadonlyArray<{ value: ShareExpiry; label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];
export const DEFAULT_EXPIRY: ShareExpiry = '7d';

/** `2026-12-03 14:20`, UTC, so the dialog and the list agree on one clock. */
export function formatUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

export function minutesLeft(iso: string, now: number): number {
  return Math.floor((Date.parse(iso) - now) / 60_000);
}

/** `in 58 min`, `in 5 hours`, `in 7 days`. */
export function relativeIn(iso: string, now: number): string {
  const min = minutesLeft(iso, now);
  if (Number.isNaN(min) || min < 1) return 'in under a minute';
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
  const d = Math.floor(h / 24);
  return `in ${d} days`;
}

/** `1 turn`, `14 turns`. */
export function turnsLabel(n: number): string {
  return `${n} ${n === 1 ? 'turn' : 'turns'}`;
}

export interface RefusalCopy {
  title: string;
  body: string;
}

/** Per-reason refusal copy for the dialog (mockup 1d). */
export function refusalCopy(refusal: ShareRefusal): RefusalCopy {
  switch (refusal.reason) {
    case 'shared_session':
      return {
        title: "This session can't be shared.",
        body: "It happened in a shared room, so it holds other people's words. Incognito sessions are refused for the same reason: you asked Ethos not to keep them.",
      };
    case 'disabled':
      return {
        title: 'Share links are off.',
        body: 'Set shareLinks.enabled to true in ~/.ethos/config.yaml to create one.',
      };
    case 'not_found':
      return {
        title: 'This session no longer exists.',
        body: 'It was deleted or never saved. Close this dialog and refresh the list.',
      };
    case 'excluded_personality':
      return {
        title: `Sharing is off for ${refusal.personalityId}.`,
        body: 'This personality is listed in shareLinks.excludePersonalities.',
      };
    case 'too_large':
      return {
        title: 'This conversation is too large to share.',
        body: `The redacted copy is over ${formatBytes(refusal.limitBytes)}.`,
      };
    case 'empty':
      return {
        title: 'Nothing to share.',
        body: 'No user or assistant message is left after redaction.',
      };
  }
}
