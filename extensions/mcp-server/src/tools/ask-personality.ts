import type { AgentEvent, AgentLoop } from '@ethosagent/core';

export interface AskPersonalityArgs {
  personality_id: string;
  prompt: string;
  session_key?: string;
}

export interface AskPersonalityResult {
  text: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
}

/** Runs the agent loop for a given personality and collects the final response. */
export async function askPersonality(
  loop: AgentLoop,
  args: AskPersonalityArgs,
): Promise<AskPersonalityResult> {
  const sessionKey = args.session_key ?? `mcp:${args.personality_id}:${Date.now()}`;

  let text = '';
  let turnCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const gen = loop.run(args.prompt, {
    sessionKey,
    personalityId: args.personality_id,
  });

  for await (const event of gen) {
    const ev = event as AgentEvent;
    if (ev.type === 'text_delta') {
      text += ev.text;
    } else if (ev.type === 'usage') {
      inputTokens += ev.inputTokens;
      outputTokens += ev.outputTokens;
    } else if (ev.type === 'done') {
      text = ev.text || text;
      turnCount = ev.turnCount;
    }
  }

  return { text, turnCount, inputTokens, outputTokens };
}

export const askPersonalityToolDef = {
  name: 'ask_personality',
  description:
    'Run a prompt through a specific Ethos personality and return the response. Each personality has a distinct identity, toolset, and memory scope.',
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
      session_key: {
        type: 'string',
        description:
          'Optional session key for conversation continuity. Omit to start a fresh session.',
      },
    },
    required: ['personality_id', 'prompt'],
  },
};
