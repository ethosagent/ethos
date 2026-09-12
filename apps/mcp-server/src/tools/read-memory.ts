import type { MemoryProvider } from '@ethosagent/types';
import { personalityMemoryContext } from '../memory-scope';

export const readMemoryToolDef = {
  name: 'read_memory',
  description:
    "Read one memory key from a personality's memory scope (~/.ethos/personalities/<id>/).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      personality_id: { type: 'string', description: 'The personality whose memory to read' },
      key: { type: 'string', description: 'Memory key, e.g. "MEMORY.md" or "USER.md"' },
    },
    required: ['personality_id', 'key'],
  },
};

export async function readMemory(
  provider: MemoryProvider,
  personalityId: string,
  key: string,
): Promise<string> {
  const entry = await provider.read(key, personalityMemoryContext(personalityId));
  return entry ? entry.content : `No content found for key: ${key}`;
}
