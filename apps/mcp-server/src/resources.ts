// MCP resources for the operator console.
//
// Memory resources go through the MemoryProvider, never the filesystem: a
// personality's memory lives at `~/.ethos/personalities/<id>/`, not at
// `~/.ethos/MEMORY.md` (`resolveScopeDir`, extensions/memory-markdown/src/index.ts),
// so the URI names the personality. Everything else reads through the injected
// `Storage` — CLAUDE.md, "Storage abstraction": no raw `node:fs` for `~/.ethos/`.

import { join } from 'node:path';
import { assertWithinBase } from '@ethosagent/core';
import type { MemoryProvider, Storage } from '@ethosagent/types';
import { assertSafeId } from '@ethosagent/types';
import { personalityMemoryContext } from './memory-scope';

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceDeps {
  /** Root data directory (`~/.ethos`). */
  dataDir: string;
  storage: Storage;
  /** Absent → no memory resources are listed or readable. */
  memoryProvider?: MemoryProvider;
}

/** Built-in personalities ship inside the extension; user ones live in `~/.ethos/personalities/`. */
function personalityDirs(dataDir: string): string[] {
  return [
    join(new URL('../../..', import.meta.url).pathname, 'extensions', 'personalities', 'data'),
    join(dataDir, 'personalities'),
  ];
}

export async function listResources(deps: ResourceDeps): Promise<McpResource[]> {
  const resources: McpResource[] = [];

  if (deps.memoryProvider) {
    const personalitiesDir = join(deps.dataDir, 'personalities');
    for (const entry of await deps.storage.listEntries(personalitiesDir)) {
      if (!entry.isDir) continue;
      let refs: Array<{ key: string }>;
      try {
        refs = await deps.memoryProvider.list(personalityMemoryContext(entry.name));
      } catch {
        // Unsafe personality id — not ours to list.
        continue;
      }
      for (const ref of refs) {
        resources.push({
          uri: `ethos://memory/${entry.name}/${ref.key}`,
          name: `${entry.name} memory: ${ref.key}`,
          mimeType: 'text/markdown',
        });
      }
    }
  }

  resources.push({
    uri: 'ethos://sessions/recent',
    name: 'Recent sessions',
    mimeType: 'application/json',
  });

  for (const dir of personalityDirs(deps.dataDir)) {
    for (const entry of await deps.storage.listEntries(dir)) {
      if (!entry.isDir) continue;
      const id = entry.name;
      if (await deps.storage.exists(join(dir, id, 'SOUL.md')))
        resources.push({
          uri: `ethos://personalities/${id}/SOUL.md`,
          name: `${id} identity`,
          mimeType: 'text/markdown',
        });
      if (await deps.storage.exists(join(dir, id, 'config.yaml')))
        resources.push({
          uri: `ethos://personalities/${id}/config.yaml`,
          name: `${id} config`,
          mimeType: 'text/yaml',
        });
    }
  }

  return resources;
}

export async function readResource(uri: string, deps: ResourceDeps): Promise<string> {
  // ethos://memory/<personality_id>/<key>
  const memoryMatch = uri.match(/^ethos:\/\/memory\/([^/]+)\/(.+)$/);
  if (memoryMatch) {
    const [, id, key] = memoryMatch;
    if (!deps.memoryProvider) {
      throw new Error('Memory provider not configured');
    }
    const entry = await deps.memoryProvider.read(key ?? '', personalityMemoryContext(id ?? ''));
    return entry?.content ?? '';
  }

  if (uri === 'ethos://sessions/recent') {
    return JSON.stringify({ message: 'Session history available via SQLite session store.' });
  }

  // ethos://personalities/<id>/SOUL.md or config.yaml
  const personalityMatch = uri.match(/^ethos:\/\/personalities\/([^/]+)\/(.+)$/);
  if (personalityMatch) {
    const [, id, file] = personalityMatch;
    assertSafeId(id ?? '', 'personalityId');
    for (const dir of personalityDirs(deps.dataDir)) {
      const p = join(dir, id ?? '', file ?? '');
      assertWithinBase(dir, p);
      const content = await deps.storage.read(p);
      if (content !== null) return content;
    }
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
