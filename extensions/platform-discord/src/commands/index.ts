import type { ChannelOverrideStore } from '@ethosagent/core';
import type { DiscordEmbed } from '../blocks/shared';
import type { Binding, ChannelMode, RoomModeDefault } from '../config';
import { handleAsk } from './ask';
import { handleHelp } from './help';
import { handleKanban } from './kanban';
import { handleMemory } from './memory';
import { handleNew } from './new';
import { handlePersonality } from './personality';
import { handleStatus } from './status';

export interface CommandPayload {
  commandName: string;
  subcommand?: string;
  options: Record<string, string>;
  channelId: string;
  userId: string;
  guildId?: string;
  /** Set when the command ran inside a thread: the thread id (`channelId` is then the thread's). */
  threadId?: string;
  /** Set with `threadId`: the thread's parent channel, which is the room (as `triageMessage` uses). */
  parentChannelId?: string;
}

/** The room a command ran in: the parent channel for a thread, plus the thread id. */
export function commandRoom(payload: CommandPayload): { chatId: string; threadId?: string } {
  return payload.threadId
    ? { chatId: payload.parentChannelId ?? payload.channelId, threadId: payload.threadId }
    : { chatId: payload.channelId };
}

export interface CommandContext {
  binding: Binding;
  defaultChannelMode: ChannelMode;
  /** `defaultChannelMode` was set in config (diagnostic source `platform`). */
  defaultChannelModeConfigured?: boolean;
  /** Room config's default reply mode (plan channel-prompts L12). */
  roomModeDefault?: RoomModeDefault;
  channelOverrides?: ChannelOverrideStore<ChannelMode>;
  memory?: MemoryReader;
  kanban?: KanbanReader;
  personalityCard?: PersonalityCardReader;
  allowedUsers?: string[];
  submitAgentTurn?: (input: { channel: string; user: string; text: string }) => Promise<void>;
}

export interface CommandResponse {
  embeds: DiscordEmbed[];
  ephemeral: boolean;
  content?: string;
}

export interface MemoryReader {
  read(store: 'memory' | 'user' | 'both'): Promise<Array<{ content: string; updatedAt?: string }>>;
  clear(store: 'memory' | 'user'): Promise<void>;
}

export interface KanbanReader {
  list(): Promise<Array<{ id: string; title: string; status: string }>>;
}

export interface PersonalityCardReader {
  get(): Promise<{ name: string; description: string; model?: string; toolset?: string[] } | null>;
  list(): Promise<Array<{ name: string; description: string }>>;
}

export async function dispatch(
  payload: CommandPayload,
  ctx: CommandContext,
): Promise<CommandResponse> {
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
] as const;
