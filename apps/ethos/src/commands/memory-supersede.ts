// `ethos memory supersede <slug> --by <slug>` — the fact lifecycle supersede op
// (memory-lifecycle L4, §3c). Marks an older `### <slug>` section replaced by a
// newer one: the section moves to `memory-archive.md` under a dated
// `> Superseded by [[#<new-slug>]]` note and its sidecar entry records
// `supersededBy`. Existing verbs only, history-recorded (source `tool`).
import { join } from 'node:path';
import { readConfig } from '@ethosagent/config';
import { type MemoryMeta, parseMemoryMeta, supersedeSlug } from '@ethosagent/nightly-loop';
import type { MemoryContext, Storage } from '@ethosagent/types';
import { openFileMemory } from '../lib/file-memory';
import { getSecretsResolver, getStorage } from '../wiring';

export async function runMemorySupersede(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const bySlug = flag('--by');
  const flagValues = new Set([flag('--personality'), bySlug]);
  const slug = args.find((a) => !a.startsWith('-') && !flagValues.has(a));
  if (!slug || !bySlug) {
    console.error('Usage: ethos memory supersede <slug> --by <slug> [--personality <id>]');
    process.exit(1);
  }

  const config = await readConfig(getStorage(), await getSecretsResolver());
  const personalityId = flag('--personality') ?? config?.personality ?? 'default';

  // Content + sidecar follow the configured backend (the vault under `memory:
  // vault`). Refused for vector.
  const backend = openFileMemory(config, 'tool');
  const mem = backend.provider;

  const ctx: MemoryContext = {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: 'cli',
    platform: 'cli',
    workingDir: process.cwd(),
  };

  const result = await supersedeSlug(mem, ctx, slug, bySlug, {
    // Second sanctioned sidecar writer besides the nightly pass (§3c): read →
    // mutate only this slug → writeAtomic, never clobbering decay bookkeeping.
    readMeta: () => readMemoryMeta(backend.storage, backend.memoryRoot, personalityId),
    writeMeta: (meta) => writeMemoryMeta(backend.storage, backend.memoryRoot, personalityId, meta),
  });

  if (!result.ok) {
    console.error(`No active section with slug "${slug}" in ${personalityId}'s memory.`);
    if (result.availableSlugs.length > 0) {
      console.error(`Active slugs: ${result.availableSlugs.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`Superseded "${slug}" (from ${result.fromKey}) by "${bySlug}" → archived.`);
}

// Read the importance/decay sidecar (M3) under the backend's memory root.
// Tolerant: missing/corrupt → empty meta.
async function readMemoryMeta(storage: Storage, root: string, id: string): Promise<MemoryMeta> {
  return parseMemoryMeta(await storage.read(join(root, 'personalities', id, 'memory-meta.json')));
}

async function writeMemoryMeta(
  storage: Storage,
  root: string,
  id: string,
  meta: MemoryMeta,
): Promise<void> {
  const scopeDir = join(root, 'personalities', id);
  await storage.mkdir(scopeDir);
  await storage.writeAtomic(join(scopeDir, 'memory-meta.json'), JSON.stringify(meta, null, 2));
}
