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

import { deriveFsReachPaths } from '@ethosagent/core';
import type { ContextInjector, PersonalityConfig } from '@ethosagent/types';

/** The id core's context assembly already keys the file-context injector on. */
const FILE_CONTEXT_INJECTOR_ID = 'file-context';

/**
 * The project-context block the first turn's prompt would carry for
 * `personality` in `workingDir`, or `''` when there is none (no injector, no
 * discovery file, `context_layering.mode: off`, or an unusable `fs_reach`,
 * which the turn itself refuses). Progressive sub-directory layers are
 * discovered later, while the agent works, so they are not part of the
 * startup prefix.
 */
export async function projectContextAtStartup(opts: {
  injectors: readonly ContextInjector[];
  personality: PersonalityConfig;
  workingDir: string;
  dataDir: string;
  platform: string;
  model: string;
}): Promise<string> {
  const injector = opts.injectors.find((i) => i.id === FILE_CONTEXT_INJECTOR_ID);
  if (!injector) return '';
  let workdir: string;
  try {
    workdir = deriveFsReachPaths(opts.personality, {
      ethosHome: opts.dataDir,
      self: opts.personality.id,
      cwd: opts.workingDir,
    }).workdir;
  } catch {
    return '';
  }
  try {
    const result = await injector.inject({
      sessionId: '',
      sessionKey: '',
      platform: opts.platform,
      model: opts.model,
      history: [],
      workingDir: workdir,
      isDm: true,
      turnNumber: 0,
      personalityId: opts.personality.id,
    });
    return result?.content ?? '';
  } catch {
    return '';
  }
}
