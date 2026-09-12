import type { MemoryProvider } from '@ethosagent/types';
import { personalityMemoryContext } from '../memory-scope';

export interface MemorySearchResult {
  /** The memory key the snippet came from, e.g. `MEMORY.md`. */
  key: string;
  snippet: string;
}

/** Which keys a `scope` filter admits. */
function admits(key: string, scope?: 'memory' | 'user' | 'all'): boolean {
  if (scope === 'memory') return key === 'MEMORY.md';
  if (scope === 'user') return key === 'USER.md';
  return true;
}

/**
 * Substring search over one personality's memory, through the provider — the
 * same bytes the agent reads (`personality:<id>` scope, `memory-scope.ts`).
 * Matching lines come back with one line of context either side.
 */
export async function searchMemory(
  provider: MemoryProvider,
  personalityId: string,
  query: string,
  scope?: 'memory' | 'user' | 'all',
  limit = 10,
): Promise<MemorySearchResult[]> {
  const entries = await provider.search(query, personalityMemoryContext(personalityId), { limit });
  const needle = query.toLowerCase();
  const results: MemorySearchResult[] = [];

  for (const entry of entries) {
    if (!admits(entry.key, scope)) continue;
    const lines = entry.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (!line.toLowerCase().includes(needle)) continue;
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      results.push({ key: entry.key, snippet: lines.slice(start, end).join('\n').trim() });
    }
  }

  return results;
}

export const searchMemoryToolDef = {
  name: 'search_memory',
  description:
    "Search one personality's memory (~/.ethos/personalities/<id>/: MEMORY.md, USER.md and any other topic files) for entries matching a query. Returns matching snippets with surrounding context.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      personality_id: {
        type: 'string',
        description: 'The personality whose memory to search',
      },
      query: {
        type: 'string',
        description: 'Search term or phrase',
      },
      scope: {
        type: 'string',
        enum: ['memory', 'user', 'all'],
        description: 'Restrict to MEMORY.md, USER.md, or search every key. Defaults to "all".',
      },
    },
    required: ['personality_id', 'query'],
  },
};
