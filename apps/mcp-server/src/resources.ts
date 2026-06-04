import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertWithinBase } from '@ethosagent/core';
import type { MemoryProvider } from '@ethosagent/types';
import { assertSafeId } from '@ethosagent/types';

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export function listResources(dataDir: string): McpResource[] {
  const resources: McpResource[] = [];

  if (existsSync(join(dataDir, 'MEMORY.md')))
    resources.push({
      uri: 'ethos://memory/MEMORY.md',
      name: 'Agent memory',
      mimeType: 'text/markdown',
    });

  if (existsSync(join(dataDir, 'USER.md')))
    resources.push({
      uri: 'ethos://memory/USER.md',
      name: 'User context',
      mimeType: 'text/markdown',
    });

  resources.push({
    uri: 'ethos://sessions/recent',
    name: 'Recent sessions',
    mimeType: 'application/json',
  });

  const personalityDirs = [
    join(new URL('../../..', import.meta.url).pathname, 'extensions', 'personalities', 'data'),
    join(dataDir, 'personalities'),
  ];

  for (const dir of personalityDirs) {
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir)) {
      const soulMd = join(dir, id, 'SOUL.md');
      const configYaml = join(dir, id, 'config.yaml');
      if (existsSync(soulMd))
        resources.push({
          uri: `ethos://personalities/${id}/SOUL.md`,
          name: `${id} identity`,
          mimeType: 'text/markdown',
        });
      if (existsSync(configYaml))
        resources.push({
          uri: `ethos://personalities/${id}/config.yaml`,
          name: `${id} config`,
          mimeType: 'text/yaml',
        });
    }
  }

  return resources;
}

export async function readResource(
  uri: string,
  dataDir: string,
  provider?: MemoryProvider,
): Promise<string> {
  // ethos://memory/MEMORY.md
  if (uri === 'ethos://memory/MEMORY.md') {
    if (provider) {
      const ctx = {
        scopeId: 'memory',
        sessionId: '',
        sessionKey: '',
        platform: 'mcp',
        workingDir: '',
      };
      const entry = await provider.read('MEMORY.md', ctx);
      return entry?.content ?? '';
    }
    const p = join(dataDir, 'MEMORY.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  if (uri === 'ethos://memory/USER.md') {
    if (provider) {
      const ctx = {
        scopeId: 'memory',
        sessionId: '',
        sessionKey: '',
        platform: 'mcp',
        workingDir: '',
      };
      const entry = await provider.read('USER.md', ctx);
      return entry?.content ?? '';
    }
    const p = join(dataDir, 'USER.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  if (uri === 'ethos://sessions/recent') {
    return JSON.stringify({ message: 'Session history available via SQLite session store.' });
  }

  // ethos://personalities/<id>/SOUL.md or config.yaml
  const personalityMatch = uri.match(/^ethos:\/\/personalities\/([^/]+)\/(.+)$/);
  if (personalityMatch) {
    const [, id, file] = personalityMatch;
    assertSafeId(id ?? '', 'personalityId');
    const dirs = [
      join(new URL('../../..', import.meta.url).pathname, 'extensions', 'personalities', 'data'),
      join(dataDir, 'personalities'),
    ];
    for (const dir of dirs) {
      const p = join(dir, id ?? '', file ?? '');
      assertWithinBase(dir, p);
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
