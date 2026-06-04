import type { MemoryProvider, MemoryUpdate } from '@ethosagent/types';

export const writeMemoryToolDef = {
  name: 'write_memory',
  description:
    'Write to a memory key via the MemoryProvider. Requires enableMemoryWrite: true on the server.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['add', 'replace', 'remove', 'delete'] },
      key: { type: 'string' },
      content: { type: 'string', description: 'Required for add and replace.' },
      substring_match: { type: 'string', description: 'Required for remove.' },
    },
    required: ['action', 'key'],
  },
};

export async function writeMemory(
  provider: MemoryProvider,
  action: 'add' | 'replace' | 'remove' | 'delete',
  key: string,
  content?: string,
  substringMatch?: string,
): Promise<string> {
  if ((action === 'add' || action === 'replace') && content === undefined) {
    return `input_invalid: content is required for action "${action}"`;
  }
  if (action === 'remove' && !substringMatch) {
    return 'input_invalid: substring_match is required for action "remove"';
  }

  let update: MemoryUpdate;
  switch (action) {
    case 'add':
      update = { action: 'add', key, content: content ?? '' };
      break;
    case 'replace':
      update = { action: 'replace', key, content: content ?? '' };
      break;
    case 'remove':
      update = { action: 'remove', key, substringMatch: substringMatch ?? '' };
      break;
    case 'delete':
      update = { action: 'delete', key };
      break;
  }

  const ctx = {
    scopeId: 'memory',
    sessionId: '',
    sessionKey: '',
    platform: 'mcp',
    workingDir: '',
  };

  await provider.sync([update], ctx);
  return `Memory updated: ${action} on ${key}`;
}
