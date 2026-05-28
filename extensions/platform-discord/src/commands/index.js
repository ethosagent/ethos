import { handleAsk } from './ask';
import { handleHelp } from './help';
import { handleKanban } from './kanban';
import { handleMemory } from './memory';
import { handleNew } from './new';
import { handlePersonality } from './personality';
import { handleStatus } from './status';
export async function dispatch(payload, ctx) {
  switch (payload.commandName) {
    case 'ask':
      return handleAsk(payload, ctx);
    case 'help':
      return handleHelp(payload, ctx);
    case 'new':
      return handleNew(payload, ctx);
    case 'personality':
      return handlePersonality(payload, ctx);
    case 'memory':
      return handleMemory(payload, ctx);
    case 'status':
      return handleStatus(payload, ctx);
    case 'kanban':
      return handleKanban(payload, ctx);
    default:
      return { embeds: [], ephemeral: true, content: `Unknown command: ${payload.commandName}` };
  }
}
export const COMMAND_DEFINITIONS = [
  {
    name: 'ethos',
    description: 'Ethos agent commands',
    options: [
      {
        name: 'ask',
        description: 'Submit a prompt to the agent',
        type: 1,
        options: [{ name: 'prompt', description: 'The prompt text', type: 3, required: true }],
      },
      { name: 'help', description: 'Show available commands', type: 1 },
      { name: 'new', description: 'Start a fresh session', type: 1 },
      {
        name: 'personality',
        description: 'Personality control',
        type: 1,
        options: [{ name: 'action', description: 'list or switch', type: 3, required: false }],
      },
      {
        name: 'memory',
        description: 'Memory control',
        type: 1,
        options: [{ name: 'action', description: 'show or clear', type: 3, required: false }],
      },
      { name: 'status', description: 'Show recent sessions and waiting clarifies', type: 1 },
      { name: 'kanban', description: 'Show kanban summary', type: 1 },
    ],
  },
];
