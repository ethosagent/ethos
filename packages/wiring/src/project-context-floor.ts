// The project-context injection (AGENTS.md / CLAUDE.md / SOUL.md found in the
// turn's working directory, rendered as `## Project Context`) is part of the
// real prompt prefix, and on a local model it can be most of it: this repo's
// AGENTS.md alone is ~78k chars. The startup static floor used to count SOUL,
// the prelude and the tool schemas but not this, so a prefix at ~95% of a 32k
// window did not enter small-window mode.
//
// This does not re-implement discovery. It asks the loop's OWN file-context
// injector (`FileContextInjector`, `extensions/skills/src/file-context-injector.ts`)
// for what it would inject on the first turn, with the working directory the
// turn resolves (`deriveFsReachPaths`, as `stages/turn-setup.ts` does), so the
// measured text is the text the prompt sends.

import { declaredWorkdirs, deriveFsReachPaths } from '@ethosagent/core';
import { FileContextInjector } from '@ethosagent/skills';
import type {
  ContextInjector,
  PersonalityConfig,
  PersonalityRegistry,
  Storage,
} from '@ethosagent/types';

/** The id core's context assembly already keys the file-context injector on. */
const FILE_CONTEXT_INJECTOR_ID = 'file-context';

/**
 * The directory a turn for `personality` resolves as its working directory
 * (`deriveFsReachPaths`, exactly as `stages/turn-setup.ts` does), or
 * `undefined` for an unusable `fs_reach`, which the turn itself refuses.
 */
export function resolveTurnWorkdir(
  personality: PersonalityConfig,
  opts: { dataDir: string; cwd: string },
): string | undefined {
  try {
    return deriveFsReachPaths(personality, {
      ethosHome: opts.dataDir,
      self: personality.id,
      cwd: opts.cwd,
    }).workdir;
  } catch {
    return undefined;
  }
}

/**
 * The root project-context block the file-context injector renders for
 * `personality` in an ALREADY-RESOLVED `workdir`, or `''` when there is none
 * (no injector, no discovery file, `context_layering.mode: off`, or an
 * injector that throws).
 *
 * The empty `sessionId` is deliberate: progressive sub-directory layers are
 * tracked per session (`FileContextInjector.sessionLayers`), so no session
 * means no progressive layers — this is the static root layer only. Those
 * layers are dynamic tail content, discovered while the agent works; they are
 * not part of the static floor and are counted per turn by the compaction
 * gate instead (see `createSmallWindowResolver`, small-window-resolver.ts).
 */
export async function projectContextFor(opts: {
  injectors: readonly ContextInjector[];
  personality: PersonalityConfig;
  workdir: string;
  platform: string;
  model: string;
}): Promise<string> {
  const injector = opts.injectors.find((i) => i.id === FILE_CONTEXT_INJECTOR_ID);
  if (!injector) return '';
  try {
    const result = await injector.inject({
      sessionId: '',
      sessionKey: '',
      platform: opts.platform,
      model: opts.model,
      history: [],
      workingDir: opts.workdir,
      isDm: true,
      turnNumber: 0,
      personalityId: opts.personality.id,
    });
    return result?.content ?? '';
  } catch {
    return '';
  }
}

/**
 * The project-context block the first turn's prompt would carry for
 * `personality` launched in `workingDir`: `resolveTurnWorkdir` then
 * `projectContextFor`. `''` when there is none.
 */
export async function projectContextAtStartup(opts: {
  injectors: readonly ContextInjector[];
  personality: PersonalityConfig;
  workingDir: string;
  dataDir: string;
  platform: string;
  model: string;
}): Promise<string> {
  const workdir = resolveTurnWorkdir(opts.personality, {
    dataDir: opts.dataDir,
    cwd: opts.workingDir,
  });
  if (workdir === undefined) return '';
  return projectContextFor({ ...opts, workdir });
}

/**
 * A file-context injector for a surface that measures without a loop in hand
 * (`ethos bench context`, the character sheet): the same class the loop
 * composes (`createInjectors`, extensions/skills/src/index.ts), minus the
 * progressive-discovery hook subscription, which a measurement never fires.
 */
export function createProjectContextInjector(opts: {
  storage: Storage;
  personalities: PersonalityRegistry;
}): ContextInjector {
  return new FileContextInjector({ storage: opts.storage, personalities: opts.personalities });
}

/**
 * The project-context contribution for a surface with no turn in hand (the
 * character sheet): the personality's declared `fs_reach` workdir and the
 * block its file-context injector renders there. `workdir` is `undefined`
 * when the personality declares no workdir, or declares one through
 * `${CWD}` — its project context then depends on the directory the process
 * runs in, and `chars` is 0.
 */
export async function declaredWorkdirProjectContext(opts: {
  injectors: readonly ContextInjector[];
  personality: PersonalityConfig;
  dataDir: string;
  cwd: string;
}): Promise<{ workdir?: string; chars: number }> {
  const declared = declaredWorkdirs(opts.personality)[0];
  if (declared === undefined || /\$\{CWD\}/.test(declared)) return { chars: 0 };
  const workdir = resolveTurnWorkdir(opts.personality, { dataDir: opts.dataDir, cwd: opts.cwd });
  if (workdir === undefined) return { chars: 0 };
  const block = await projectContextFor({
    injectors: opts.injectors,
    personality: opts.personality,
    workdir,
    platform: 'cli',
    model: '',
  });
  return { workdir, chars: block.length };
}
