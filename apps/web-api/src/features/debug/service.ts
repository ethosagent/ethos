import type { AgentLoop } from '@ethosagent/core';
import type { SessionStore } from '@ethosagent/types';

export interface DebugServiceOptions {
  sessionStore: SessionStore;
  agentLoop: AgentLoop;
}

export interface DebugChatInput {
  mainSessionId: string;
  message: string;
  clientId?: string;
}

export interface DebugChatOutput {
  sessionId: string;
  turnId: string;
  response: string;
}

export class DebugService {
  private readonly sessionStore: SessionStore;
  private readonly agentLoop: AgentLoop;

  constructor(opts: DebugServiceOptions) {
    this.sessionStore = opts.sessionStore;
    this.agentLoop = opts.agentLoop;
  }

  async chat(input: DebugChatInput): Promise<DebugChatOutput> {
    const debugSessionKey = `${input.mainSessionId}:debug`;
    const turnId = `debug-${Date.now()}`;

    // Guard: stub agentLoop used during onboarding has no completeDirect
    if (typeof this.agentLoop.completeDirect !== 'function') {
      return {
        sessionId: debugSessionKey,
        turnId,
        response: 'Setup required — complete onboarding first.',
      };
    }

    // Load recent messages from the main session for context
    const recentMessages = await this.sessionStore.getMessages(input.mainSessionId, { limit: 20 });

    let contextBlock = '';
    if (recentMessages.length > 0) {
      const lines = recentMessages.map((m) => {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content.slice(0, 500)}`;
      });
      contextBlock = `\n<session_context>\n${lines.join('\n')}\n</session_context>\n`;
    }

    const userContent = `${contextBlock}\nUser question: ${input.message}`;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);

    const chunks: string[] = [];
    let finishReason = '';
    const chunkTypes: string[] = [];

    try {
      for await (const chunk of this.agentLoop.completeDirect(
        [{ role: 'user', content: userContent }],
        {
          system:
            'You are a debug assistant for the Ethos agent framework. Be terse and precise. Diagnose root causes, not symptoms. You have access to recent session messages as context.',
          maxTokens: 1024,
          abortSignal: abort.signal,
        },
      )) {
        chunkTypes.push(chunk.type);
        if (chunk.type === 'text_delta') {
          chunks.push(chunk.text);
        } else if (chunk.type === 'done') {
          finishReason = chunk.finishReason;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { sessionId: debugSessionKey, turnId, response: `Error: ${msg}` };
    } finally {
      clearTimeout(timer);
    }

    const text = chunks.join('').trim();
    const response =
      text ||
      `No text returned. finish_reason=${finishReason || 'none'}, chunk_types=[${chunkTypes.join(',')}], context_messages=${recentMessages.length}`;
    return { sessionId: debugSessionKey, turnId, response };
  }
}
