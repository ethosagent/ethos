import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      const ethosMd = join(dir, id, 'ETHOS.md');
      const configYaml = join(dir, id, 'config.yaml');
      if (existsSync(ethosMd))
        resources.push({
          uri: `ethos://personalities/${id}/ETHOS.md`,
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

export function readResource(uri: string, dataDir: string): string {
  // ethos://memory/MEMORY.md
  if (uri === 'ethos://memory/MEMORY.md') {
    const p = join(dataDir, 'MEMORY.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  if (uri === 'ethos://memory/USER.md') {
    const p = join(dataDir, 'USER.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  if (uri === 'ethos://sessions/recent') {
    return JSON.stringify({ message: 'Session history available via SQLite session store.' });
  }

  // ethos://personalities/<id>/ETHOS.md or config.yaml
  const personalityMatch = uri.match(/^ethos:\/\/personalities\/([^/]+)\/(.+)$/);
  if (personalityMatch) {
    const [, id, file] = personalityMatch;
    const dirs = [
      join(new URL('../../..', import.meta.url).pathname, 'extensions', 'personalities', 'data'),
      join(dataDir, 'personalities'),
    ];
    for (const dir of dirs) {
      const p = join(dir, id ?? '', file ?? '');
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
