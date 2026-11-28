import type { TurnAudience, WorldId } from '@ethosagent/types';
import type { MountsFile, WorldFile } from './config';
import { privateWorldId, sharedWorldId } from './ids';

export interface ResolvedWorld {
  id: WorldId;
  /** World slug for shared worlds, `private` for the personality's own. */
  tag: string;
  /** The personality's own name for the mount (`as:`), or null. */
  alias: string | null;
  mode: 'write' | 'propose' | 'read';
  audience: 'owner_only' | 'shareable';
  /** True for `world:<slug>`; agent writes on a shared world are proposals (R1). */
  shared: boolean;
}

export type InertReason = 'not_granted' | 'unknown_world' | 'audience';

export interface AccessResult {
  visible: ResolvedWorld[];
  inert: Array<{ world: string; reason: InertReason }>;
}

/**
 * The one access function (mounts ∩ grants ∩ audience). Pure: no I/O, no
 * clock; the caller loads `mounts` and `worlds` and passes them in.
 *
 * What pins the guarantees, all in `src/__tests__/world-access.test.ts`:
 * - R7, a personality cannot grant itself a world: 'R7 mount refused when the
 *   world does not list the personality' and 'private world is never visible
 *   to another personality'.
 * - R6, owner_only worlds are dropped per world in a shared turn: 'R6
 *   per-world audience in a shared turn'. An unknown audience (`undefined`)
 *   is treated as shared: 'undefined audience is treated as shared'.
 * - A propose mount with only a reader grant is read: 'propose mount with a
 *   reader grant resolves to read'.
 */
export function resolveAccess(input: {
  personalityId: string;
  audience: TurnAudience | undefined;
  mounts: MountsFile;
  worlds: ReadonlyMap<string, WorldFile>;
}): AccessResult {
  const { personalityId, mounts, worlds } = input;
  const sharedTurn = input.audience !== 'private';
  const visible: ResolvedWorld[] = [];
  const inert: AccessResult['inert'] = [];

  // Rule 1: the private world belongs to its personality alone, and is
  // owner_only like any other, so a shared turn drops it (rule 3).
  if (!sharedTurn) {
    visible.push({
      id: privateWorldId(personalityId),
      tag: 'private',
      alias: null,
      mode: 'write',
      audience: 'owner_only',
      shared: false,
    });
  }

  for (const mount of mounts.mounts) {
    const world = worlds.get(mount.world);
    if (!world) {
      inert.push({ world: mount.world, reason: 'unknown_world' });
      continue;
    }
    // Rule 2: the world's own grants decide, not the mount.
    const isProposer = world.proposers.includes(personalityId);
    const isReader = world.readers.includes(personalityId);
    let mode: 'propose' | 'read';
    if (mount.mode === 'propose' && isProposer) mode = 'propose';
    else if (isProposer || isReader) mode = 'read';
    else {
      inert.push({ world: mount.world, reason: 'not_granted' });
      continue;
    }
    // Rule 3: per world, not all-or-nothing.
    if (sharedTurn && world.audience === 'owner_only') {
      inert.push({ world: mount.world, reason: 'audience' });
      continue;
    }
    visible.push({
      id: sharedWorldId(world.id),
      tag: world.id,
      alias: mount.as ?? null,
      mode,
      audience: world.audience,
      shared: true,
    });
  }
  return { visible, inert };
}

/** `acme:Ravi`, `private:billing-svc`; an alias, when set, replaces the tag. */
export function displayTag(w: ResolvedWorld, entityName: string): string {
  return `${w.alias ?? w.tag}:${entityName}`;
}
