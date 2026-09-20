// The one feedback-row vocabulary (D7): glyph + word · mono subject · result ·
// right-aligned time. Plain data so probes, errors and notices can produce rows
// without importing React Native; `components/ui/Row.tsx` renders it.
export type Glyph = '✓' | '✗' | '⚠' | '·';

export interface RowData {
  glyph: Glyph;
  word: string;
  subject: string;
  result?: string;
  time?: string;
}

/** `HH:MM` in the phone's clock, for a row's time column. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
