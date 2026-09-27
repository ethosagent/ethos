import { PHONE_PRESET_SCOPES } from '@ethosagent/web-contracts';

// What the app needs from its key, and from its server (§1). Connect REFUSES on
// either rather than enabling a phone that fails FORBIDDEN on the first message:
// scopes are immutable once minted, so a wrong key costs a re-mint.

/** One owner for the set: the web's phone preset and `--preset phone` (S13). */
export const REQUIRED_SCOPES: readonly string[] = PHONE_PRESET_SCOPES;

/** The first release that ships `meta.whoami` and `/healthz` `version` (S12). */
export const MIN_SERVER_VERSION = '0.8.1';

export const MINT_COMMAND = 'ethos api-key create --preset phone --qr';

export function missingScopes(granted: readonly string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !granted.includes(s));
}

/**
 * Scopes a screen uses beyond the preset (T5's Agents › Memory). Connect does
 * NOT refuse on these: a key without one renders that screen's FORBIDDEN row
 * (§11, `errorRow` in ./errors.ts) and the rest of the app works. The Agents
 * tab's other reads (`teams:read`, `cron:read`, `personalities:read`) are in
 * the preset, so they are required; so is everything the Teams tab calls
 * (`teams:read`, `kanban:read`, `kanban:write`) and the run card's
 * `tasks.get`/`tasks.cancel` (`sessions:read`, `chat:send`). Each screen still
 * renders a FORBIDDEN row (`errorRow`) if a call is refused.
 */
export const OPTIONAL_SCOPES = {
  'memory:read': 'Agent · Memory',
  'memory:write': 'Agent · Memory · Approve / Reject',
} as const satisfies Record<string, string>;

/** The optional scopes this key lacks, with the screen each one feeds. */
export function missingOptionalScopes(
  granted: readonly string[],
): Array<{ scope: string; screen: string }> {
  return Object.entries(OPTIONAL_SCOPES)
    .filter(([scope]) => !granted.includes(scope))
    .map(([scope, screen]) => ({ scope, screen }));
}

/**
 * Numeric `major.minor.patch` compare; a pre-release or build suffix is ignored.
 *
 * `version` is a source build's `dev` (or any other string with no numeric
 * component) when `ethos serve` runs from source under tsx — the tsup
 * `define` that bakes in a real version number only exists in a built binary
 * (ETHOS_VERSION in apps/ethos/src/version-info.ts). A build from source
 * necessarily contains this work, so it is treated as satisfying any floor
 * rather than as `0.0.0`.
 */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) =>
    v
      .split(/[-+]/)[0]
      ?.split('.')
      .map((n) => (/^\d+$/.test(n) ? Number(n) : null)) ?? [];
  const a = parse(version);
  if (a.every((n) => n === null)) return true;
  const b = parse(min).map((n) => n ?? 0);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
