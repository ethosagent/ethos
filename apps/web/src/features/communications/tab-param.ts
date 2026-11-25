/** The tab `/communications` opens when `?tab=` is absent or names nothing. */
export const COMMUNICATIONS_DEFAULT_TAB = 'telegram';

/** `?tab=<key>` -> a tab that exists. A stale link or a typo lands on the
 *  default tab instead of rendering nothing. */
export function resolveCommunicationsTab(
  param: string | null,
  validKeys: readonly string[],
): string {
  return param !== null && validKeys.includes(param) ? param : COMMUNICATIONS_DEFAULT_TAB;
}
