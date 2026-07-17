// Shared restore logic (memory-experience pillar C, §4.2).
//
// The inverse of decay: an archived section (demoted to `memory-archive.md` by
// the nightly pass) returns to its live memory file, addressed by slug. Both
// the CLI (`ethos memory restore <slug>`) and the web Timeline restore action
// call this one function so the round-trip is identical from either surface —
// and both write through a `restore`-labelled history handle, so the move is a
// single visible, auditable event.
import type { MemoryContext, MemoryProvider, MemoryUpdate } from '@ethosagent/types';
import { parseArchiveBlocks } from './memory-decay';

/** Outcome of a restore attempt. `ok: false` carries the archive's known slugs
 *  so a caller can list them back to the user. */
export type RestoreResult =
  | { ok: true; restoredTo: string }
  | { ok: false; error: string; availableSlugs: string[] };

/**
 * Move the archived section with `slug` back into its origin file. Picks the
 * most-recent block when the archive holds duplicates (mirrors the CLI's
 * `lastIndexOf`), appends it to `fromKey`, and rewrites the archive without it.
 * Both writes go through `memory.sync`, so a `restore`-labelled provider records
 * them in the history.
 */
export async function restoreArchivedSlug(
  memory: Pick<MemoryProvider, 'read' | 'sync'>,
  ctx: MemoryContext,
  slug: string,
): Promise<RestoreResult> {
  const archive = (await memory.read('memory-archive.md', ctx))?.content ?? '';
  const blocks = parseArchiveBlocks(archive);
  const targetIndex = blocks.map((b) => b.slug).lastIndexOf(slug);
  const target = targetIndex >= 0 ? blocks[targetIndex] : undefined;
  if (!target) {
    return {
      ok: false,
      error: `No archived section with slug "${slug}".`,
      availableSlugs: [...new Set(blocks.map((b) => b.slug))],
    };
  }

  const remaining = blocks.filter((_, i) => i !== targetIndex);
  const newArchive = remaining.map((b) => b.raw).join('\n\n');
  const updates: MemoryUpdate[] = [
    { action: 'add', key: target.fromKey, content: target.section },
    { action: 'replace', key: 'memory-archive.md', content: newArchive },
  ];
  await memory.sync(updates, ctx);
  return { ok: true, restoredTo: target.fromKey };
}
