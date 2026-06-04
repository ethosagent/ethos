import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import OpenAI from 'openai';
import { streamTextToolCalls } from './text-tool-call-transport';
import { buildChatCompletionsParamsAsync, streamChatCompletions } from './transport';

export { streamTextToolCalls } from './text-tool-call-transport';
export type { ChatCompletionsStreamParams } from './transport';
export {
  buildChatCompletionsParams,
  buildChatCompletionsParamsAsync,
  streamChatCompletions,
} from './transport';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAICompatProviderConfig {
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxContextTokens?: number;
  toolCallFormat?: 'openai' | 'text-xml';
}

// ---------------------------------------------------------------------------
// Gemini schema normalization
// Gemini via OpenAI-compat rejects several JSON Schema fields that OpenAI allows.
// ---------------------------------------------------------------------------

const GEMINI_STRIP_KEYS = new Set([
  'minLength',
  'maxLength',
  'pattern',
  'format',
  '$schema',
  'additionalProperties',
]);

export function normalizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(schema)) {
    if (GEMINI_STRIP_KEYS.has(k)) continue;

    // Gemini doesn't support array `type` (e.g. ["string", "null"])
    if (k === 'type' && Array.isArray(v)) {
      // Take the first non-null type
      const nonNull = (v as string[]).find((t) => t !== 'null');
      if (nonNull) out.type = nonNull;
      continue;
    }

    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = normalizeGeminiSchema(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? normalizeGeminiSchema(item as Record<string, unknown>)
          : item,
      );
    } else {
      out[k] = v;
    }
  }

  return out;
}

function isGeminiEndpoint(baseUrl: string): boolean {
  return baseUrl.includes('generativelanguage.googleapis.com');
}

// ---------------------------------------------------------------------------
// Message conversion: our Message[] → OpenAI ChatCompletionMessageParam[]
// ---------------------------------------------------------------------------

// Exported for adapter tests — pure function over Message[] with no side effects.
export function toOpenAIMessages(
  messages: Message[],
  system?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // MessageContent[] — split into OpenAI format
    if (msg.role === 'user') {
      // Collect tool_result blocks as tool messages
      const toolResults: Array<{ tool_call_id: string; content: string }> = [];
      const textParts: string[] = [];
      // Vision / document parts (OpenAI Chat Completions multipart content).
      const mediaParts: OpenAI.Chat.ChatCompletionContentPart[] = [];

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.push({ tool_call_id: block.tool_use_id, content: block.content });
        } else if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'image') {
          // OpenAI Chat Completions vision: data: URI inside image_url.
          mediaParts.push({
            type: 'image_url',
            image_url: { url: `data:${block.mediaType};base64,${block.data}` },
          });
        } else if (block.type === 'document') {
          // OpenAI Chat Completions PDF: `file` content part with base64
          // file_data + filename. Documented for the OpenAI API itself; some
          // OpenAI-compat backends (Ollama, older Gemini surfaces) reject it
          // — the capability table in vision_analyze (P2) gates by provider.
          mediaParts.push({
            type: 'file',
            file: {
              file_data: `data:${block.mediaType};base64,${block.data}`,
              filename: 'document.pdf',
            },
          });
        }
      }

      // User content: if any media is present we MUST emit a multipart array
      // because OpenAI rejects an image_url block inside a plain string.
      if (mediaParts.length > 0) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const t of textParts) parts.push({ type: 'text', text: t });
        for (const m of mediaParts) parts.push(m);
        result.push({ role: 'user', content: parts });
      } else if (textParts.length > 0) {
        result.push({ role: 'user', content: textParts.join('\n') });
      }

      // Tool results as separate tool messages
      for (const tr of toolResults) {
        result.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
      }
    } else {
      // assistant — may have text + tool_use blocks
      const textParts: string[] = [];
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }

      result.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-model pricing (USD per million tokens, approximate)
// ---------------------------------------------------------------------------

const OPENAI_PRICING: Array<{ prefix: string; input: number; output: number }> = [
  // OpenAI
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { prefix: 'gpt-4o', input: 2.5, output: 10 },
  { prefix: 'gpt-4-turbo', input: 10, output: 30 },
  { prefix: 'gpt-4', input: 30, output: 60 },
  { prefix: 'gpt-3.5-turbo', input: 0.5, output: 1.5 },
  // Google Gemini
  { prefix: 'gemini-2.0-flash', input: 0.1, output: 0.4 },
  { prefix: 'gemini-1.5-flash', input: 0.075, output: 0.3 },
  { prefix: 'gemini-1.5-pro', input: 1.25, output: 5.0 },
  // DeepSeek
  { prefix: 'deepseek-v3', input: 0.14, output: 0.28 },
  { prefix: 'deepseek-r1', input: 0.55, output: 2.19 },
  // Mistral
  { prefix: 'mistral-large', input: 2.0, output: 6.0 },
  { prefix: 'mistral-small', input: 0.1, output: 0.3 },
];

export function estimateCostOpenAI(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = OPENAI_PRICING.find((r) => model.toLowerCase().includes(r.prefix));
  if (!p) return 0; // unknown model — local/Ollama or unrecognised
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// OpenAICompatProvider
// ---------------------------------------------------------------------------

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly supportsVision = { images: true, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  private readonly client: OpenAI;
  private readonly gemini: boolean;
  private readonly toolCallFormat: 'openai' | 'text-xml';

  constructor(config: OpenAICompatProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.gemini = isGeminiEndpoint(config.baseUrl);
    this.toolCallFormat = config.toolCallFormat ?? 'openai';
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const params = await buildChatCompletionsParamsAsync(messages, tools, options, this.model, {
      gemini: this.gemini,
      countTokens: (msgs) => this.countTokens(msgs),
    });

    if (this.toolCallFormat === 'text-xml') {
      // Strip structured tools so the model uses text-based XML tool calls
      const paramsNoTools = {
        ...params,
        oaiParams: { ...params.oaiParams, tools: undefined },
      };
      yield* streamTextToolCalls(
        streamChatCompletions(this.client, paramsNoTools, options.abortSignal),
      );
    } else {
      yield* streamChatCompletions(this.client, params, options.abortSignal);
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    // OpenAI-compat providers don't expose a token-count endpoint.
    // Rough approximation: 1 token ≈ 4 chars.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }
}
