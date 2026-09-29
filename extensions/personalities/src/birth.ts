// The birth marker (plan personality-presence-and-initiative §1).
//
// `learning/birth/<personalityId>.json` under the state dir, written by the
// operator's create paths — `FilePersonalityRegistry.create(…, { birth: true })`
// (the web create forms and `ethos personality create --blank`) and
// `markPersonalityBorn` (`ethos personality create --from` and the AI-assisted
// create, apps/ethos/src/commands/personality-create.ts) — and read by the
// birth-ritual injector (`createBirthRitualInjector`, packages/wiring/src/
// birth-ritual.ts). It is cleared when an identity amendment for that
// personality is applied (`createAmendmentService`, packages/wiring/src/
// amendments.ts) and by `ethos personality birth skip <id>`
// (apps/ethos/src/commands/personality-birth.ts).
//
// Why `learning/`, not the personality's own directory: `learning` is on the
// state-dir deny list for READ and WRITE (`STATE_DIR_DENY_ENTRIES`,
// packages/storage-fs/src/sensitive-paths.ts), so no turn's ScopedStorage or
// ScopedFs can see, plant or clear it, whatever `fs_reach` the personality
// declares. The personality's own directory is in its default write reach
// (`deriveFsReachPaths`, packages/core/src/fs-reach.ts), and a marker there
// would sit outside `PERSONALITY_DEFINITION_ENTRIES`, so the personality
// could delete it. `learning/` is also outside the six fingerprinted
// personality paths, so writing or clearing it never busts the mtime cache.
// Pinned by the 'the birth marker' cases in
// packages/wiring/src/__tests__/birth-ritual.test.ts.
//
// Limitation: a personality holding a shell tool under LOCAL execution runs
// as the Ethos user and can reach any file, this one included — the same
// exception `PERSONALITY_DEFINITION_ENTRIES` documents in fs-reach.ts.

import { join } from 'node:path';
import { assertSafeId, parseToolsetYaml, renderToolsetYaml, type Storage } from '@ethosagent/types';

/**
 * `propose_self_amendment` (`PROPOSE_SELF_AMENDMENT_TOOL`,
 * extensions/tools-personality-design/src/propose-amendment.ts — not imported:
 * this package does not depend on that one). The birth ritual ends by filing
 * an identity amendment with it, and the intake files only for a personality
 * whose toolset lists it (check 3, `createAmendmentIntake`,
 * packages/wiring/src/amendments.ts).
 */
const BIRTH_FILING_TOOL = 'propose_self_amendment';

/**
 * A created personality's toolset with {@link BIRTH_FILING_TOOL} appended, so
 * its birth ritual can file. An EMPTY toolset is left alone: it means "every
 * built-in tool", and one entry would narrow it to that tool — such a
 * personality cannot file (check 3 refuses an undeclared toolset), so the
 * ritual stays silent for it. The tool only FILES; a person applies at the
 * TTY-gated CLI. It is added by the OPERATOR's create path, never granted by
 * `scaffold_personality`, whose D13 bound (a new personality holds no tool its
 * creator lacks) is untouched. Pinned by 'the birth marker' cases in
 * packages/wiring/src/__tests__/birth-ritual.test.ts and by
 * apps/ethos/src/commands/__tests__/personality-create-birth.test.ts.
 */
export function withBirthFilingTool(toolset: readonly string[]): string[] {
  if (toolset.length === 0 || toolset.includes(BIRTH_FILING_TOOL)) return [...toolset];
  return [...toolset, BIRTH_FILING_TOOL];
}

/** `<dataDir>/learning/birth/<personalityId>.json`. */
export function birthMarkerPath(dataDir: string, personalityId: string): string {
  assertSafeId(personalityId, 'personalityId');
  return join(dataDir, 'learning', 'birth', `${personalityId}.json`);
}

export async function writeBirthMarker(
  storage: Storage,
  dataDir: string,
  personalityId: string,
  now: () => number = Date.now,
): Promise<void> {
  const path = birthMarkerPath(dataDir, personalityId);
  await storage.mkdir(join(dataDir, 'learning', 'birth'));
  await storage.writeAtomic(
    path,
    `${JSON.stringify({ personalityId, createdAt: new Date(now()).toISOString() })}\n`,
  );
}

export async function hasBirthMarker(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<boolean> {
  return storage.exists(birthMarkerPath(dataDir, personalityId));
}

/**
 * When the marker was written (its `createdAt`, epoch ms), or `null` when there
 * is no marker or its body is unreadable. The birth-ritual injector counts only
 * identity amendments filed at or after this, so a record left by an earlier
 * personality with the same id does not end the new one's ritual
 * (`createBirthRitualInjector`, packages/wiring/src/birth-ritual.ts).
 */
export async function birthMarkerCreatedAt(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<number | null> {
  const raw = await storage.read(birthMarkerPath(dataDir, personalityId));
  if (raw === null) return null;
  try {
    const body: unknown = JSON.parse(raw);
    const createdAt =
      body && typeof body === 'object' ? (body as { createdAt?: unknown }).createdAt : undefined;
    const ms = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** Remove the marker. Resolves `true` when there was one to remove. */
export async function clearBirthMarker(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<boolean> {
  const path = birthMarkerPath(dataDir, personalityId);
  if (!(await storage.exists(path))) return false;
  await storage.remove(path);
  return true;
}

/**
 * Make a user personality that already exists on disk born, as
 * `FilePersonalityRegistry.create(…, { birth: true })` makes a new one: its
 * declared `toolset.yaml` gets {@link withBirthFilingTool} and the marker is
 * written. For the create paths whose files another writer produced — a
 * duplicate (`ethos personality create --from`) and the personality-architect's
 * `scaffold_personality` (the AI-assisted `ethos personality create`). Recipe
 * installs never call it. `<dataDir>/personalities/<id>` is the user dir
 * (`FilePersonalityRegistry.userPathFor`).
 */
export async function markPersonalityBorn(
  storage: Storage,
  dataDir: string,
  personalityId: string,
  now: () => number = Date.now,
): Promise<void> {
  assertSafeId(personalityId, 'personalityId');
  const toolsetPath = join(dataDir, 'personalities', personalityId, 'toolset.yaml');
  const live = await storage.read(toolsetPath);
  if (live !== null) {
    const toolset = parseToolsetYaml(live);
    const born = withBirthFilingTool(toolset);
    if (born.length !== toolset.length) {
      await storage.writeAtomic(toolsetPath, renderToolsetYaml(born));
    }
  }
  await writeBirthMarker(storage, dataDir, personalityId, now);
}
