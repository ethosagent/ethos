import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSafety, PersonalityConfig, Storage } from '@ethosagent/types';

export function substitute(
  template: string,
  vars: { ethosHome: string; self: string; cwd: string },
): string {
  return template
    .replace(/\$\{ETHOS_HOME\}/g, vars.ethosHome)
    .replace(/\$\{self\}/g, vars.self)
    .replace(/\$\{CWD\}/g, vars.cwd);
}

export function buildScopedStorage(
  personality: PersonalityConfig,
  storage: Storage | undefined,
  safety: AgentSafety,
  dataDir: string | undefined,
  workingDir: string,
): Storage | undefined {
  if (!storage) return undefined;

  const ethosHome = dataDir ?? join(homedir(), '.ethos');
  const cwd = workingDir;
  const self = personality.id;
  const ownDir = `${join(ethosHome, 'personalities', self)}/`;

  const fsReach = personality.fs_reach;
  const readPrefixes =
    fsReach?.read && fsReach.read.length > 0
      ? fsReach.read.map((p) => substitute(p, { ethosHome, self, cwd }))
      : [ownDir, `${join(ethosHome, 'skills')}/`, cwd];
  const writePrefixes =
    fsReach?.write && fsReach.write.length > 0
      ? fsReach.write.map((p) => substitute(p, { ethosHome, self, cwd }))
      : [ownDir, cwd];

  return safety.scopedStorageFactory(storage, {
    read: readPrefixes,
    write: writePrefixes,
  });
}
