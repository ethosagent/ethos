import { fetchWithTransientRetry, type TransientRetryOptions } from '@ethosagent/core';
import { estimateCost } from '@ethosagent/pricing';
import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { flattenCompactionEnvelopes } from '@ethosagent/types';
import { EventStreamDecoder, type EventStreamMessage } from './eventstream';
import { type SigV4Config, SigV4Signer } from './sigv4';

export interface BedrockTransportConfig {
  region: string;
  sigv4: SigV4Config;
  modelId: string;
  /** UBP-030 — pre-first-byte retry of a 429/5xx/network failure (`fetchWithTransientRetry`, packages/core/src/providers/transient-retry.ts). */
  retry?: TransientRetryOptions;
}

export async function* streamBedrockConverse(
  config: BedrockTransportConfig,
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  signal?: AbortSignal,
): AsyncGenerator<CompletionChunk> {
  const signer = new SigV4Signer(config.sigv4);
  const endpoint = `https://bedrock-runtime.${config.region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(config.modelId)}/converse-stream`;
  const url = `${endpoint}${path}`;

  const body = buildConverseBody(messages, tools, options);
  const bodyStr = JSON.stringify(body);

  const signed = await signer.sign({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      accept: 'application/vnd.amazon.eventstream',
    },
    body: bodyStr,
  });

  const response = await fetchWithTransientRetry(
    () => fetch(url, { method: 'POST', headers: signed.headers, body: bodyStr, signal }),
    signal,
    config.retry,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new BedrockStreamError(
      `Bedrock API error ${response.status}: ${errorText}`,
      'httpError',
      response.status,
    );
  }

  if (!response.body) throw new Error('Bedrock response has no body');

  yield* parseBedrockEventStream(response.body, config.modelId);
}

function buildConverseBody(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
): Record<string, unknown> {
  // Item 7 (D33) — a persisted server-compaction block reaches this provider
  // as its readable summary; the Anthropic-only encrypted half is dropped.
  const converseMessages = flattenCompactionEnvelopes(messages).map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(convertContent),
  }));

  const body: Record<string, unknown> = {
    messages: converseMessages,
    ...(options.system ? { system: [{ text: options.system }] } : {}),
    inferenceConfig: {
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { topP: options.topP } : {}),
      ...(options.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
    },
  };

  if (tools.length > 0) {
    body.toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.parameters },
        },
      })),
    };
  }

  return body;
}

function convertContent(c: { type: string; [key: string]: unknown }): Record<string, unknown> {
  switch (c.type) {
    case 'text':
      return { text: c.text };
    case 'tool_use':
      return { toolUse: { toolUseId: c.id, name: c.name, input: c.input } };
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: c.tool_use_id,
          content: [{ text: c.content }],
          status: c.is_error ? 'error' : 'success',
        },
      };
    case 'image':
      return {
        image: { format: (c.mediaType as string).split('/')[1], source: { bytes: c.data } },
      };
    case 'document':
      return { document: { format: 'pdf', source: { bytes: c.data } } };
    default:
      return { text: String(c.text ?? '') };
  }
}

/**
 * A ConverseStream failure: an `exception` or `error` frame inside a 200
 * response, or a non-2xx reply. `status` follows the HTTP status the
 * exception maps to, so `classifyProviderError`
 * (packages/core/src/providers/chained-provider.ts) reads a throttle as
 * `rate_limit` and fails over instead of treating it as an empty success.
 */
export class BedrockStreamError extends Error {
  readonly status: number | undefined;
  readonly code: string;

  constructor(message: string, code: string, status: number | undefined) {
    super(message);
    this.name = 'BedrockStreamError';
    this.code = code;
    this.status = status;
  }
}

/** The HTTP status Bedrock documents for each ConverseStream exception. */
const EXCEPTION_STATUS: Record<string, number> = {
  throttlingException: 429,
  serviceUnavailableException: 503,
  internalServerException: 500,
  modelStreamErrorException: 424,
  validationException: 400,
  accessDeniedException: 403,
  resourceNotFoundException: 404,
  modelTimeoutException: 408,
};

function headerString(message: EventStreamMessage, name: string): string | undefined {
  const value = message.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function parsePayload(message: EventStreamMessage): Record<string, unknown> {
  const text = new TextDecoder().decode(message.payload);
  if (text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finishReasonOf(
  stopReason: unknown,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  if (stopReason === 'tool_use') return 'tool_use';
  if (stopReason === 'max_tokens') return 'max_tokens';
  if (stopReason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

/**
 * Decode a ConverseStream body (binary AWS event-stream, see ./eventstream)
 * into `CompletionChunk`s. The `:event-type` header drives dispatch; payloads
 * are the bare event objects (`{contentBlockIndex, delta}`), not wrapped.
 * Tool calls are tracked per `contentBlockIndex`, so every delta carries its
 * block's `toolUseId`, and `contentBlockStop` closes a call with
 * `tool_use_end`. Exported for the recorded-fixture tests.
 */
export async function* parseBedrockEventStream(
  body: ReadableStream<Uint8Array>,
  modelId: string,
): AsyncGenerator<CompletionChunk> {
  const reader = body.getReader();
  const decoder = new EventStreamDecoder();
  const toolBlocks = new Map<number, { toolUseId: string; name: string; json: string }>();
  let sawMessageStop = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of decoder.push(value)) {
        yield* handleBedrockMessage(message, modelId, toolBlocks, () => {
          sawMessageStop = true;
        });
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawMessageStop) {
    throw new BedrockStreamError(
      `Bedrock ConverseStream for ${modelId} ended without messageStop` +
        (decoder.pendingBytes > 0 ? ` (${decoder.pendingBytes} bytes of a partial frame)` : '') +
        ' — the stream was cut off',
      'incompleteStream',
      undefined,
    );
  }
}

function* handleBedrockMessage(
  message: EventStreamMessage,
  modelId: string,
  toolBlocks: Map<number, { toolUseId: string; name: string; json: string }>,
  onMessageStop: () => void,
): Generator<CompletionChunk> {
  const messageType = headerString(message, ':message-type') ?? 'event';

  if (messageType === 'exception') {
    const code = headerString(message, ':exception-type') ?? 'unknownException';
    const payload = parsePayload(message);
    const detail = typeof payload.message === 'string' ? payload.message : '';
    const original = payload.originalStatusCode;
    const status = typeof original === 'number' ? original : EXCEPTION_STATUS[code];
    throw new BedrockStreamError(
      `Bedrock ConverseStream ${code}${status !== undefined ? ` (${status})` : ''}: ${detail}`,
      code,
      status,
    );
  }
  if (messageType === 'error') {
    const code = headerString(message, ':error-code') ?? 'unknownError';
    const detail = headerString(message, ':error-message') ?? '';
    throw new BedrockStreamError(
      `Bedrock ConverseStream error ${code}: ${detail}`,
      code,
      undefined,
    );
  }

  const eventType = headerString(message, ':event-type');
  const event = parsePayload(message);
  const index = typeof event.contentBlockIndex === 'number' ? event.contentBlockIndex : 0;

  switch (eventType) {
    case 'contentBlockStart': {
      const toolUse = asRecord(asRecord(event.start)?.toolUse);
      if (toolUse && typeof toolUse.toolUseId === 'string' && typeof toolUse.name === 'string') {
        toolBlocks.set(index, { toolUseId: toolUse.toolUseId, name: toolUse.name, json: '' });
        yield { type: 'tool_use_start', toolCallId: toolUse.toolUseId, toolName: toolUse.name };
      }
      return;
    }
    case 'contentBlockDelta': {
      const delta = asRecord(event.delta);
      if (!delta) return;
      if (typeof delta.text === 'string') {
        yield { type: 'text_delta', text: delta.text };
        return;
      }
      const toolUse = asRecord(delta.toolUse);
      if (toolUse) {
        const block = toolBlocks.get(index);
        if (!block) {
          throw new BedrockStreamError(
            `Bedrock ConverseStream sent a toolUse delta for content block ${index} with no ` +
              'contentBlockStart — refusing to guess which tool call it belongs to',
            'orphanToolDelta',
            undefined,
          );
        }
        const input = typeof toolUse.input === 'string' ? toolUse.input : '';
        block.json += input;
        yield { type: 'tool_use_delta', toolCallId: block.toolUseId, partialJson: input };
        return;
      }
      const reasoning = asRecord(delta.reasoningContent);
      if (reasoning && typeof reasoning.text === 'string') {
        yield { type: 'thinking_delta', thinking: reasoning.text };
      }
      return;
    }
    case 'contentBlockStop': {
      const block = toolBlocks.get(index);
      if (block) {
        toolBlocks.delete(index);
        yield { type: 'tool_use_end', toolCallId: block.toolUseId, inputJson: block.json };
      }
      return;
    }
    case 'messageStop': {
      if (toolBlocks.size > 0) {
        const names = [...toolBlocks.values()].map((b) => b.name).join(', ');
        throw new BedrockStreamError(
          `Bedrock ConverseStream stopped while tool-call arguments were streaming (${names}) — ` +
            'refusing to execute a possibly truncated tool call',
          'truncatedToolUse',
          undefined,
        );
      }
      onMessageStop();
      yield { type: 'done', finishReason: finishReasonOf(event.stopReason) };
      return;
    }
    case 'metadata': {
      const usage = asRecord(event.usage);
      if (!usage) return;
      const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
      const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
      // Bedrock model ids carry the vendor model name
      // (`us.anthropic.claude-sonnet-4-...`), so the shared table resolves
      // them without Bedrock-specific rows.
      const costEstimate = estimateCost(modelId, { inputTokens, outputTokens });
      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: costEstimate.costUsd,
        },
        costBasis: costEstimate.basis,
      };
      return;
    }
    default:
      // messageStart and any event type added later carry nothing to map.
      return;
  }
}
