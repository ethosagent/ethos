import type { MemoryProvider } from '@ethosagent/types';

export const readMemoryToolDef = {
  name: 'read_memory',
  description: 'Read the content of a memory key via the MemoryProvider.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      key: { type: 'string', description: 'Memory key, e.g. "MEMORY.md" or "architecture.md"' },
      scope: {
        type: 'string',
        description:
          'scopeId, e.g. "personality:researcher" or "team:engineering". Defaults to server default scope.',
      },
    },
    required: ['key'],
  },
};

export async function readMemory(
  provider: MemoryProvider,
  key: string,
  scope?: string,
): Promise<string> {
  const ctx = {
    scopeId: scope ?? 'memory',
    sessionId: '',
    sessionKey: '',
    platform: 'mcp',
    workingDir: '',
  };
  const entry = await provider.read(key, ctx);
  return entry ? entry.content : `No content found for key: ${key}`;
}
