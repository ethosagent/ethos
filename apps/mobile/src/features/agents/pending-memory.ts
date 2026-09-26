import type { RowData } from '../../lib/row';
import { clock } from '../../lib/row';

// A parked memory write (`memory.pendingList`, approve-before-store) as the
// row §5 draws — `⚠ proposed · MEMORY.md · add · "…" · 9:39` — and as the
// review sheet's key/value lines.

export type PendingUpdate =
  | { action: 'add' | 'replace'; key: string; content: string }
  | { action: 'remove'; key: string; substringMatch: string }
  | { action: 'delete'; key: string };

export interface PendingLike {
  id: string;
  update: PendingUpdate;
  source: string;
  sessionId?: string;
  proposedAt: number;
}

/** What the write carries: its content, the substring it removes, or nothing. */
export function pendingText(update: PendingUpdate): string {
  if (update.action === 'remove') return update.substringMatch;
  if (update.action === 'delete') return '';
  return update.content;
}

const QUOTE_MAX = 60;

export function pendingRow(p: PendingLike): RowData {
  const text = pendingText(p.update).replace(/\s+/g, ' ').trim();
  const quoted = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text;
  return {
    glyph: '⚠',
    word: 'proposed',
    subject: `${p.update.key} · ${p.update.action}`,
    result: quoted ? `"${quoted}"` : undefined,
    time: clock(p.proposedAt),
  };
}

/** The sheet's store / action / from lines. */
export function pendingDetail(p: PendingLike): Array<{ key: string; value: string }> {
  return [
    { key: 'store', value: p.update.key },
    { key: 'action', value: p.update.action },
    { key: 'from', value: [p.source, p.sessionId].filter(Boolean).join(' · ') },
  ];
}

/** The sheet closes once the list it was opened from no longer carries the id. */
export function isResolved(list: readonly PendingLike[] | undefined, id: string): boolean {
  return list !== undefined && !list.some((p) => p.id === id);
}

/** The pending list's query key — the Memory screen and the review sheet share it. */
export const pendingKey = (personalityId: string) => ['memory', 'pending', personalityId] as const;
