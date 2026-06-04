import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import type OpenAI from 'openai';
import { estimateCostOpenAI, normalizeGeminiSchema, toOpenAIMessages } from './index';

// ---------------------------------------------------------------------------
// Shared Chat Completions streaming transport
// ---------------------------------------------------------------------------

export interface ChatCompletionsStreamParams {
  oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming;
  requestTokens?: { system: number; tools: number; messages: number };
  effectiveModel: string;
}

/**
 * Pure function that converts Ethos messages + options into the OpenAI Chat
 * Completions streaming params object. No I/O — all side-effect-free.
 */
export function buildChatCompletionsParams(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  model: string,
  opts?: { gemini?: boolean; countTokens?: (msgs: Message[]) => Promise<number> },
): ChatCompletionsStreamParams {
  const oaiMessages = toOpenAIMessages(messages, options.system);

  const oaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: opts?.gemini ? normalizeGeminiSchema(t.parameters) : t.parameters,
    },
  }));

  const effectiveModel = options.modelOverride ?? model;
  const oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: effectiveModel,
    messages: oaiMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
  };

  return { oaiParams, requestTokens: undefined, effectiveModel };
}

/**
 * Async version of buildChatCompletionsParams that also performs per-slice
 * token computation when a countTokens callback is provided.
 */
export async function buildChatCompletionsParamsAsync(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  model: string,
  opts?: { gemini?: boolean; countTokens?: (msgs: Message[]) => Promise<number> },
): Promise<ChatCompletionsStreamParams> {
  const result = buildChatCompletionsParams(messages, tools, options, model, opts);

  // Per-slice token computation (P1 observability) — best-effort, never blocks the call.
  if (opts?.countTokens) {
    try {
      const oaiTools = result.oaiParams.tools ?? [];
      const systemText = options.system ?? '';
      const toolsText = oaiTools.length > 0 ? JSON.stringify(oaiTools) : '';
      const [sysTk, toolsTk, msgTk] = await Promise.all([
        systemText ? opts.countTokens([{ role: 'user', content: systemText }]) : 0,
        toolsText ? opts.countTokens([{ role: 'user', content: toolsText }]) : 0,
        opts.countTokens(messages),
      ]);
      result.requestTokens = { system: sysTk, tools: toolsTk, messages: msgTk };
    } catch {
      // Best-effort: if token counting fails, requestTokens stays undefined.
    }
  }

  return result;
}

/**
 * Streams Chat Completions from any OpenAI-compatible client (OpenAI or
 * AzureOpenAI — both extend the same base). Yields canonical CompletionChunk
 * events that AgentLoop can consume directly.
 */
export async function* streamChatCompletions(
  client: OpenAI,
  params: ChatCompletionsStreamParams,
  signal?: AbortSignal,
): AsyncIterable<CompletionChunk> {
  const stream = await client.chat.completions.create(params.oaiParams, { signal });

  // Track streaming tool calls by index (OpenAI streams them as deltas)
  const pendingTools = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];

    // Usage chunk (comes on its own chunk when stream_options.include_usage=true)
    if (!choice && chunk.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: estimateCostOpenAI(
            params.effectiveModel,
            chunk.usage.prompt_tokens,
            chunk.usage.completion_tokens,
          ),
          requestTokens: params.requestTokens,
        },
        metadata: {},
      };
      continue;
    }

    if (!choice) continue;

    const delta = choice.delta;

    if (delta.content) {
      yield { type: 'text_delta', text: delta.content };
    }

    // Stream tool call deltas
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index;

      if (!pendingTools.has(idx)) {
        // First delta for this tool call — has id and name
        const id = tc.id ?? '';
        const name = tc.function?.name ?? '';
        pendingTools.set(idx, { id, name, args: '' });
        yield { type: 'tool_use_start', toolCallId: id, toolName: name };
      }

      const pending = pendingTools.get(idx);
      if (pending && tc.function?.arguments) {
        pending.args += tc.function.arguments;
        yield {
          type: 'tool_use_delta',
          toolCallId: pending.id,
          partialJson: tc.function.arguments,
        };
      }
    }

    // Finish
    if (
      choice.finish_reason === 'tool_calls' ||
      choice.finish_reason === 'stop' ||
      choice.finish_reason === 'length'
    ) {
      for (const [, tc] of pendingTools) {
        yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: tc.args };
      }
      pendingTools.clear();

      let finishReason: 'tool_use' | 'end_turn' | 'max_tokens' = 'end_turn';
      if (choice.finish_reason === 'tool_calls') finishReason = 'tool_use';
      else if (choice.finish_reason === 'length') finishReason = 'max_tokens';

      yield { type: 'done', finishReason };
    }
  }
}
