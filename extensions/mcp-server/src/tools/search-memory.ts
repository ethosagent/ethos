import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MemorySearchResult {
  store: 'memory' | 'user';
  snippet: string;
}

/** Simple substring search over MEMORY.md and USER.md. */
export function searchMemory(
  dataDir: string,
  query: string,
  scope?: 'memory' | 'user' | 'all',
): MemorySearchResult[] {
  const results: MemorySearchResult[] = [];
  const lower = query.toLowerCase();

  const files: { store: 'memory' | 'user'; path: string }[] = [];
  if (!scope || scope === 'all' || scope === 'memory')
    files.push({ store: 'memory', path: join(dataDir, 'MEMORY.md') });
  if (!scope || scope === 'all' || scope === 'user')
    files.push({ store: 'user', path: join(dataDir, 'USER.md') });

  for (const { store, path } of files) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (!line.toLowerCase().includes(lower)) continue;

      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      results.push({ store, snippet: lines.slice(start, end).join('\n').trim() });
    }
  }

  return results;
}

export const searchMemoryToolDef = {
  name: 'search_memory',
  description:
    'Search Ethos agent memory files (MEMORY.md and USER.md) for entries matching a query. Returns matching snippets with surrounding context.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search term or phrase',
      },
      scope: {
        type: 'string',
        enum: ['memory', 'user', 'all'],
        description: 'Which memory file to search. Defaults to "all".',
      },
    },
    required: ['query'],
  },
};
