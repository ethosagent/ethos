// `ethos memory retract <slug> [--reason <text>]` — the fact lifecycle retract
// op (memory-lifecycle L4, §3c). Moves the active `### <slug>` section to
// `memory-archive.md` with a dated `> Retracted` note AND tombstones every fact
// in it, so proactive capture never re-proposes the fact — even after a nightly
// reword. The move is history-recorded (source `tool`); the tombstone lands in
// the same `memory-tombstones.jsonl` capture's dedup consults (L2).
import { join } from 'node:path';
import { ethosDir, readConfig } from '@ethosagent/config';
import { type MemoryMeta, parseMemoryMeta, retractSlug } from '@ethosagent/nightly-loop';
import type { MemoryContext } from '@ethosagent/types';
import { createMemoryProvider, hashFact, TombstoneStore } from '@ethosagent/wiring';
import { getSecretsResolver, getStorage } from '../wiring';

export async function runMemoryRetract(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flagValues = new Set([flag('--personality'), flag('--reason')]);
  const slug = args.find((a) => !a.startsWith('-') && !flagValues.has(a));
  if (!slug) {
    console.error('Usage: ethos memory retract <slug> [--reason <text>] [--personality <id>]');
    process.exit(1);
  }

  const config = await readConfig(getStorage(), await getSecretsResolver());
  const personalityId = flag('--personality') ?? config?.personality ?? 'default';
  const reason = flag('--reason');
  const scopeId = `personality:${personalityId}`;
  const dir = ethosDir();

  const mem = createMemoryProvider({ dataDir: dir, storage: getStorage(), source: 'tool' });
  const tombstones = new TombstoneStore({ storage: getStorage(), dataDir: dir });

  const ctx: MemoryContext = {
    scopeId,
    sessionId: '',
    sessionKey: 'cli',
    platform: 'cli',
    workingDir: process.cwd(),
  };

  const result = await retractSlug(
    mem,
    ctx,
    slug,
    {
      hashFact,
      addTombstone: (h, r) => tombstones.add(scopeId, h, r),
      // Second sanctioned sidecar writer besides the nightly pass (§3c): read →
      // mutate only this slug → writeAtomic, so a concurrent nightly rebuild
      // (which carries lifecycle entries forward) is never clobbered.
      readMeta: () => readMemoryMeta(dir, personalityId),
      writeMeta: (meta) => writeMemoryMeta(dir, personalityId, meta),
    },
    reason,
  );

  if (!result.ok) {
    console.error(`No active section with slug "${slug}" in ${personalityId}'s memory.`);
    if (result.availableSlugs.length > 0) {
      console.error(`Active slugs: ${result.availableSlugs.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(
    `Retracted "${slug}" from ${result.fromKey} → archived and tombstoned (${result.tombstoned ?? 0} fact-hash(es)).`,
  );
}

// Read the importance/decay sidecar (M3). Tolerant: missing/corrupt → empty meta.
async function readMemoryMeta(dir: string, id: string): Promise<MemoryMeta> {
  return parseMemoryMeta(
    await getStorage().read(join(dir, 'personalities', id, 'memory-meta.json')),
  );
}

async function writeMemoryMeta(dir: string, id: string, meta: MemoryMeta): Promise<void> {
  const scopeDir = join(dir, 'personalities', id);
  await getStorage().mkdir(scopeDir);
  await getStorage().writeAtomic(join(scopeDir, 'memory-meta.json'), JSON.stringify(meta, null, 2));
}
