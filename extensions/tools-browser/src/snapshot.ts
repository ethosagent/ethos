// ---------------------------------------------------------------------------
// Take an accessibility snapshot and format it
// ---------------------------------------------------------------------------

import type { Page } from 'playwright';
import { type A11yRef, parseAriaSnapshot } from './a11y';

export async function snapshotPage(
  page: Page,
): Promise<{ text: string; refs: Map<string, A11yRef>; title: string; url: string }> {
  const title = await page.title();
  const url = page.url();

  // page.locator('body').ariaSnapshot() is the Playwright 1.44+ recommended API.
  // It returns a YAML string; parseAriaSnapshot injects @e{n} refs.
  const yaml = await page.locator('body').ariaSnapshot();
  const { text, refs } = parseAriaSnapshot(yaml);

  return { text, refs, title, url };
}

// ---------------------------------------------------------------------------
// windowSnapshotAtScroll — the part of a snapshot around the scroll position
// ---------------------------------------------------------------------------

export interface ScrollMetrics {
  scrollY: number;
  innerHeight: number;
  scrollHeight: number;
}

/**
 * The most `windowSnapshotAtScroll` returns. It sits below browser_scroll's
 * `maxResultChars` (20_000) so the `[title] url` header still fits.
 */
export const SCROLL_WINDOW_CHARS = 18_000;

/**
 * UBP-039. The full-page snapshot of a long page is larger than the tool's
 * result budget, and executeParallel keeps only its HEAD — so every scroll
 * used to return the same top-of-page text. This keeps the lines around the
 * viewport instead: the viewport's centre, as a fraction of the page height,
 * picks the anchor line, and the window grows outwards from it until
 * `maxChars` is spent (a side that reaches the end of the snapshot hands its
 * share to the other). Lines left out are counted in a marker at each end.
 * The mapping from pixels to lines is proportional, not exact: a page whose
 * tall regions carry few lines puts the anchor a little off, which is why the
 * window is centred rather than starting at the anchor. Pinned by
 * __tests__/scroll-window.test.ts.
 */
export function windowSnapshotAtScroll(
  text: string,
  pos: ScrollMetrics,
  maxChars: number = SCROLL_WINDOW_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const fraction =
    pos.scrollHeight > 0
      ? Math.min(1, Math.max(0, (pos.scrollY + pos.innerHeight / 2) / pos.scrollHeight))
      : 0;
  const anchor = Math.round(fraction * (lines.length - 1));

  // Reserve room for the two markers (each well under 40 chars).
  const budget = maxChars - 80;
  let start = anchor;
  let end = anchor + 1; // exclusive
  let used = (lines[anchor] ?? '').length;
  let grew = true;
  while (grew) {
    grew = false;
    const below = lines[end];
    if (below !== undefined && used + below.length + 1 <= budget) {
      used += below.length + 1;
      end++;
      grew = true;
    }
    const above = lines[start - 1];
    if (above !== undefined && used + above.length + 1 <= budget) {
      used += above.length + 1;
      start--;
      grew = true;
    }
  }

  const out = lines.slice(start, end);
  if (start > 0) out.unshift(`[… ${start} lines above …]`);
  if (end < lines.length) out.push(`[… ${lines.length - end} lines below …]`);
  return out.join('\n');
}
