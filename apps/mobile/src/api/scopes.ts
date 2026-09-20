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

/** Numeric `major.minor.patch` compare; a pre-release or build suffix is ignored. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) =>
    v
      .split(/[-+]/)[0]
      ?.split('.')
      .map((n) => Number(n) || 0) ?? [];
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
