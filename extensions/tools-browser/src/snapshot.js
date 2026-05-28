// ---------------------------------------------------------------------------
// Take an accessibility snapshot and format it
// ---------------------------------------------------------------------------
import { parseAriaSnapshot } from './a11y';
export async function snapshotPage(page) {
  const title = await page.title();
  const url = page.url();
  // page.locator('body').ariaSnapshot() is the Playwright 1.44+ recommended API.
  // It returns a YAML string; parseAriaSnapshot injects @e{n} refs.
  const yaml = await page.locator('body').ariaSnapshot();
  const { text, refs } = parseAriaSnapshot(yaml);
  return { text, refs, title, url };
}
