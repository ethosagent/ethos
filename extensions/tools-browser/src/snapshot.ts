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
