// UBP-047 — a process started at `/` or `$HOME` hands every personality that
// declares no `fs_reach.workdir` (and no read/write list) that directory as its
// default read and write reach (`deriveFsReachPaths`, packages/core/src/fs-reach.ts):
// the whole home directory or filesystem, minus the deny floor and the state
// dir. GUI- and launchd-started hosts often run from `/`. That reach is legal,
// so boot does not refuse it; it says so once. Called by `buildAgentLoop`
// (build-agent-loop.ts); pinned by __tests__/cwd-reach-warning.test.ts.

import { resolve } from 'node:path';
import { declaredWorkdirs } from '@ethosagent/core';
import type { PersonalityConfig } from '@ethosagent/types';

/** True when the personality's reach falls back to the process cwd. */
function usesCwdDefault(personality: PersonalityConfig): boolean {
  if (declaredWorkdirs(personality).length > 0) return false;
  const reach = personality.fs_reach;
  const declaredRead = (reach?.read?.length ?? 0) > 0;
  const declaredWrite = (reach?.write?.length ?? 0) > 0;
  return !(declaredRead && declaredWrite);
}

/**
 * The boot warning for a cwd of `/` or `home`, naming the personalities whose
 * default reach it becomes; `undefined` when there is nothing to warn about.
 */
export function cwdReachWarning(
  personalities: readonly PersonalityConfig[],
  cwd: string,
  home: string,
): string | undefined {
  const dir = resolve(cwd);
  if (dir !== '/' && dir !== resolve(home)) return undefined;
  const ids = personalities.filter(usesCwdDefault).map((p) => p.id);
  if (ids.length === 0) return undefined;
  return (
    `fs_reach: process cwd is ${dir} and ${ids.join(', ')} declare${ids.length === 1 ? 's' : ''} ` +
    `no workdir; the default read/write reach covers ${dir} minus the deny floor and the ` +
    `state dir. Start from a project directory or set fs_reach.workdir in config.yaml.`
  );
}
