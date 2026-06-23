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

/**
 * Runtime validation for CommandDefinition.
 * Returns an error string if invalid, null if valid.
 * Pure function — no external imports (zero-dep contract).
 */
export function validateCommandDefinition(def: CommandDefinition): string | null {
  if (!def.name) return 'name is required';
  if (!def.description) return 'description is required';
  const hasPrompt = typeof def.prompt === 'string';
  const hasRun = typeof def.run === 'function';
  if (hasPrompt && hasRun) return 'exactly one of prompt or run must be set, not both';
  if (!hasPrompt && !hasRun) return 'exactly one of prompt or run must be set';
  if (
    def.allowedTools !== undefined &&
    (!Array.isArray(def.allowedTools) || !def.allowedTools.every((t) => typeof t === 'string'))
  ) {
    return 'allowedTools must be a string array';
  }
  const validScopes: string[] = ['global', 'project', 'personality', 'plugin'];
  if (def.scope !== undefined && !validScopes.includes(def.scope)) {
    return 'scope must be one of global, project, personality, plugin';
  }
  return null;
}
