import type { Storage } from './storage';
import type { ToolRegistry } from './tool';

export interface CommandContext {
  args: { raw: string; positional: string[]; named: Record<string, string> };
  personalityId?: string;
  sessionId: string;
  emit: (text: string) => void;
  storage?: Storage;
  tools?: ToolRegistry;
}

export interface CommandResult {
  exitCode: number;
  output?: string;
}

export type CommandScope = 'global' | 'project' | 'personality' | 'plugin';

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  prompt?: string;
  run?: (ctx: CommandContext) => Promise<CommandResult>;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  scope?: CommandScope;
  pluginId?: string;
}
