// What an archive CANNOT carry (F04 follow-up, plan
// architecture-suggestions-2026-09-10).
//
// Every scope rule in `scopes.ts` is `<dataDir>`-relative, so a `memory: vault`
// deployment — whose memory content and `.ethos-meta/` provenance live in the
// operator's own vault directory — has NO memory in any backup. Carrying an
// arbitrary external path inside the archive is a format decision (an entry
// path outside the tree, and a restore that must refuse to write outside
// `dataDir` unless the config still points at that vault), so until that is
// designed the honest minimum is to say so, every time, and name the path the
// operator has to back up themselves.

import type { MemoryBackendSelection } from '../memory-backend';
import { vaultMemoryRoots } from '../memory-backend';

export interface ExternalMemoryNotice {
  /** The agent's subtree of the vault: memory content. */
  path: string;
  /** Its provenance history + blobs (`.ethos-meta`). */
  metaPath: string;
  /** One line, ready to print next to the archive's other exclusions. */
  message: string;
}

/** The notice for this memory selection, or `null` when memory is inside `dataDir`. */
export function externalMemoryNotice(
  selection: MemoryBackendSelection,
): ExternalMemoryNotice | null {
  const roots = vaultMemoryRoots(selection);
  if (!roots) return null;
  return {
    path: roots.agentRoot,
    metaPath: roots.metaRoot,
    message:
      `memory: vault — ${roots.agentRoot} (memory content) and ${roots.metaRoot} ` +
      '(provenance history) are outside the data directory and are NOT in this archive. ' +
      'Back that directory up yourself.',
  };
}
