import { randomUUID } from 'node:crypto';
import type { AgentLoop } from '@ethosagent/core';
import { collectTurnResult, type TurnFailure } from '../turn-result';

/** `conversation` is a client-chosen label, not a session key. */
const CONVERSATION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface AskPersonalityArgs {
  personality_id: string;
  prompt: string;
  /**
   * Optional conversation label. Omit for a fresh conversation — the returned
   * `conversation` continues it. There is deliberately no `session_key`: each
   * surface owns its own session-key namespace (CLAUDE.md, "Session key
   * convention"; A2A's server-built `a2a:<personalityId>:<peerFingerprint>` in
   * `packages/a2a/src/rpc.ts` is the precedent), so a client cannot name
   * `cli:ethos` and continue someone else's session.
   */
  conversation?: string;
}

export interface AskPersonalityResult {
  text: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Pass back as `conversation` to continue this conversation. */
  conversation: string;
  /** The key the server built: `mcp-console:<personality_id>:<conversation>`. */
  sessionKey: string;
  /** Set when the turn was refused or halted — the caller renders `isError`. */
  error?: TurnFailure;
}

/** Thrown for a malformed `conversation`; the server renders it as `isError`. */
export class InvalidConversationError extends Error {
  readonly code = 'input_invalid' as const;
  constructor(value: string) {
    super(
      `input_invalid: conversation must match ${CONVERSATION_PATTERN.source} (got ${JSON.stringify(value)})`,
    );
    this.name = 'InvalidConversationError';
  }
}

/** The session key this surface owns. Never client-supplied. */
export function mcpConsoleSessionKey(personalityId: string, conversation: string): string {
  return `mcp-console:${personalityId}:${conversation}`;
}

/** Runs the agent loop for a given personality and collects the final response. */
export async function askPersonality(
  loop: AgentLoop,
  args: AskPersonalityArgs,
): Promise<AskPersonalityResult> {
  const conversation = args.conversation ?? randomUUID();
  if (!CONVERSATION_PATTERN.test(conversation)) {
    throw new InvalidConversationError(conversation);
  }
  const sessionKey = mcpConsoleSessionKey(args.personality_id, conversation);

  const turn = await collectTurnResult(
    loop.run(args.prompt, { sessionKey, personalityId: args.personality_id }),
  );

  return { ...turn, conversation, sessionKey };
}

export const askPersonalityToolDef = {
  name: 'ask_personality',
  description:
    'Run a prompt through a specific Ethos personality and return the response. Each personality has a distinct identity, toolset, and memory scope. The reply is the first content block; the second is JSON carrying the `conversation` id — pass it back to continue the same conversation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personality_id: {
        type: 'string',
        description: 'The personality ID (e.g. "researcher", "engineer", "coach")',
      },
      prompt: {
        type: 'string',
        description: 'The message to send to the personality',
      },
      conversation: {
        type: 'string',
        description:
          'Optional conversation id from a previous call, to continue it. Letters, digits, hyphen and underscore, 1-64 characters. Omit to start a fresh conversation and receive a generated id.',
        pattern: CONVERSATION_PATTERN.source,
      },
    },
    required: ['personality_id', 'prompt'],
  },
};
