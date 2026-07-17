// `ethos memory restore <slug>` — move an archived section back into its live
// memory file (memory-experience pillar C, §4.2). Decay is reversible: a
// section demoted to `memory-archive.md` returns to MEMORY.md/USER.md by slug,
// and the move is recorded in the provenance history under `source: 'restore'`.
import { ethosDir, readConfig } from '@ethosagent/config';
import { restoreArchivedSlug } from '@ethosagent/nightly-loop';
import type { MemoryContext } from '@ethosagent/types';
import { getSecretsResolver, getStorage } from '../wiring';

/**
 * `ethos memory restore <slug> [--personality <id>]`
 *
 * Finds the archived section with the given slug (most-recent when the archive
 * holds duplicates), appends it back to the file it came from, and rewrites the
 * archive without it. Both writes go through the `restore`-labelled history
 * handle, so the round-trip is one visible, auditable event.
 */
export async function runMemoryRestore(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const slug = args.find((a) => !a.startsWith('-') && a !== flag('--personality'));
  if (!slug) {
    console.error('Usage: ethos memory restore <slug> [--personality <id>]');
    process.exit(1);
  }

  const config = await readConfig(getStorage(), await getSecretsResolver());
  const personalityId = flag('--personality') ?? config?.personality ?? 'default';

  const { createMemoryProvider } = await import('@ethosagent/wiring');
  const mem = createMemoryProvider({
    dataDir: ethosDir(),
    storage: getStorage(),
    source: 'restore',
  });

  const ctx: MemoryContext = {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: 'cli',
    platform: 'cli',
    workingDir: process.cwd(),
  };

  const result = await restoreArchivedSlug(mem, ctx, slug);
  if (!result.ok) {
    console.error(`No archived section with slug "${slug}" in ${personalityId}'s memory.`);
    if (result.availableSlugs.length > 0) {
      console.error(`Archived slugs: ${result.availableSlugs.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`Restored "${slug}" to ${result.restoredTo}.`);
}
