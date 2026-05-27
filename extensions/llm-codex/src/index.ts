import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  TokenUsage,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { toResponsesInput, toResponsesTools } from './responses-adapter';

export { ensureValidToken } from './auth';
export type { CodexCredentials } from './auth';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CodexProviderConfig {
  model: string;
  getAccessToken: () => Promise<string>;
  maxContextTokens?: number;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>. Yields one event
 * per `event:` + `data:` pair, delimited by blank lines.
 */
async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete events (delimited by double newline).
      const parts = buffer.split('\n\n');
      // The last element is an incomplete chunk — keep it in the buffer.
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;

        let event = '';
        let data = '';

        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data = line.slice(5).trim();
          }
        }

        if (event && data) {
          yield { event, data };
        }
      }
    }

    // Flush remaining buffer — the stream may close without a trailing blank line.
    if (buffer.trim()) {
      let event = '';
      let data = '';

      for (const line of buffer.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim();
        }
      }

      if (event && data) {
        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

// ---------------------------------------------------------------------------
// CodexProvider
// ---------------------------------------------------------------------------

export class CodexProvider implements LLMProvider {
  readonly name = 'codex';
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = false;
  readonly supportsThinking = false;

  private readonly getAccessToken: () => Promise<string>;

  constructor(config: CodexProviderConfig) {
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 200_000;
    this.getAccessToken = config.getAccessToken;
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const token = await this.getAccessToken();
    const effectiveModel = options.modelOverride ?? this.model;

    const body: Record<string, unknown> = {
      model: effectiveModel,
      input: toResponsesInput(messages),
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };

    if (options.system) {
      body.instructions = options.system;
    }

    const responsesTools = toResponsesTools(tools);
    if (responsesTools.length > 0) {
      body.tools = responsesTools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    if (options.maxTokens) {
      body.max_output_tokens = options.maxTokens;
    }

    const response = await fetch(RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Codex Responses API error ${response.status}: ${text || response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error('Codex Responses API returned no body');
    }

    // Per-slice token estimate (best-effort, mirrors other providers).
    let requestTokens: { system: number; tools: number; messages: number } | undefined;
    try {
      const systemText = options.system ?? '';
      const toolsText = responsesTools.length > 0 ? JSON.stringify(responsesTools) : '';
      requestTokens = {
        system: Math.ceil(systemText.length / 4),
        tools: Math.ceil(toolsText.length / 4),
        messages: await this.countTokens(messages),
      };
    } catch {
      // Best-effort: if counting fails, requestTokens stays undefined.
    }

    // Track tool calls in flight for mapping deltas to tool IDs.
    let currentToolId = '';
    let hasToolCalls = false;

    for await (const sse of parseSSE(response.body)) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(sse.data) as Record<string, unknown>;
      } catch {
        continue; // Skip malformed JSON
      }

      switch (sse.event) {
        case 'response.output_text.delta': {
          const delta = (payload as { delta?: string }).delta;
          if (delta) {
            yield { type: 'text_delta', text: delta };
          }
          break;
        }

        case 'response.output_item.added': {
          const item = payload.item as { type?: string; id?: string; name?: string } | undefined;
          if (item?.type === 'function_call' && item.id && item.name) {
            currentToolId = item.id;
            hasToolCalls = true;
            yield { type: 'tool_use_start', toolCallId: item.id, toolName: item.name };
          }
          break;
        }

        case 'response.function_call_arguments.delta': {
          const delta = (payload as { delta?: string }).delta;
          if (delta && currentToolId) {
            yield { type: 'tool_use_delta', toolCallId: currentToolId, partialJson: delta };
          }
          break;
        }

        case 'response.output_item.done': {
          const item = payload.item as {
            type?: string;
            id?: string;
            arguments?: string;
          } | undefined;
          if (item?.type === 'function_call' && item.id) {
            yield {
              type: 'tool_use_end',
              toolCallId: item.id,
              inputJson: item.arguments ?? '',
            };
            // Reset for the next tool call in the same response.
            currentToolId = '';
          }
          break;
        }

        case 'response.completed': {
          const resp = payload.response as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
            };
          } | undefined;
          const inputTokens = resp?.usage?.input_tokens ?? 0;
          const outputTokens = resp?.usage?.output_tokens ?? 0;

          const usage: TokenUsage = {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0, // Codex pricing not publicly available
            requestTokens,
          };
          yield { type: 'usage', usage };

          yield {
            type: 'done',
            finishReason: hasToolCalls ? 'tool_use' : 'end_turn',
          };
          break;
        }

        // Ignore other event types (response.created, response.in_progress, etc.)
      }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    // No token-counting API available — rough character-based estimate.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }
}
