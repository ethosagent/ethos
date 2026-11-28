// Pure rules behind the Worlds tab (plan world-model Task 7.4). Nothing here
// touches the DOM, so the alias and inert-reason rules are pinned without a
// render (pages/personalities/__tests__/worlds-tab.test.ts).

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

export interface MountDraft {
  world: string;
  mode: 'read' | 'propose';
  as?: string;
}

/**
 * The same rules the server applies on save (parseMountsYaml in
 * extensions/world-service/src/config.ts): an alias is a slug, unique per
 * personality, and never another mounted world's slug. Pinned by
 * 'alias collision blocks save'. Keyed by row index.
 */
export function aliasProblems(mounts: readonly MountDraft[]): Map<number, string> {
  const problems = new Map<number, string>();
  const slugs = new Set(mounts.map((m) => m.world));
  const seen = new Set<string>();
  mounts.forEach((m, i) => {
    if (m.as === undefined) return;
    if (!SLUG.test(m.as)) {
      problems.set(i, `"${m.as}" is not a valid alias (lowercase letters, digits, - and _)`);
      return;
    }
    if (seen.has(m.as)) problems.set(i, `duplicate alias "${m.as}"`);
    else if (m.as !== m.world && slugs.has(m.as)) {
      problems.set(i, `alias "${m.as}" equals the slug of another mounted world`);
    }
    seen.add(m.as);
  });
  return problems;
}

/** The server's effective-mount note (WorldsService.effectiveOf), as a sentence for the owner. */
export function describeNote(world: string, personalityId: string, note: string): string {
  if (note === 'inert: not in readers or proposers') {
    return `${world} does not list ${personalityId} as a reader`;
  }
  if (note === 'inert: no such world') return `${world} does not exist`;
  if (note === 'not in proposers') {
    return `${world} lists ${personalityId} as a reader only, so this mount reads`;
  }
  return `${world}: ${note}`;
}

/** Where the owner grants access: the world's settings view. */
export function worldSettingsHref(world: string): string {
  const q = new URLSearchParams({ world: `world:${world}`, view: 'settings' });
  return `/world?${q.toString()}`;
}

export function sameMounts(a: readonly MountDraft[], b: readonly MountDraft[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => m.world === b[i]?.world && m.mode === b[i]?.mode && m.as === b[i]?.as)
  );
}
