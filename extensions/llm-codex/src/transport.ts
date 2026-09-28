import { fetchWithTransientRetry, type TransientRetryOptions } from '@ethosagent/core';
import { estimateCost } from '@ethosagent/pricing';
import type { CompletionChunk, TokenUsage } from '@ethosagent/types';

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
// ResponsesApiBody
// ---------------------------------------------------------------------------

export interface ResponsesApiBody {
  model: string;
  input: unknown[];
  stream: true;
  // `store`, `reasoning` and `include` are Codex's choices, not the API's
  // requirements. They are optional so a second consumer of this transport can
  // omit what it does not want rather than send an empty placeholder.
  store?: boolean;
  reasoning?: { effort: string; summary: string };
  include?: string[];
  instructions?: string;
  tools?: unknown[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
}

// ---------------------------------------------------------------------------
// ResponsesApiError
// ---------------------------------------------------------------------------

/** A non-2xx reply, or a failure reported inside a 200 stream (UBP-034:
 *  `response.failed`, `error`, a `response.incomplete` that is not a
 *  `max_output_tokens` stop, or a stream cut off before its terminal event).
 *  Carries the HTTP status (absent for an in-stream failure), the raw body, and
 *  the vendor's error `code` (e.g. `context_length_exceeded`,
 *  `rate_limit_exceeded`), which `isContextOverflowError`
 *  (packages/core/src/agent-loop/overflow.ts) and `classifyProviderError`
 *  (packages/core/src/providers/chained-provider.ts) read to compact or fail
 *  over instead of accepting a partial answer. */
export class ResponsesApiError extends Error {
  readonly status: number | undefined;
  readonly body: string;
  readonly code: string | undefined;

  constructor(message: string, status: number | undefined, body: string, code?: string) {
    super(message);
    this.name = 'ResponsesApiError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

function usageFrom(
  resp: unknown,
  model: string,
  requestTokens: { system: number; tools: number; messages: number } | undefined,
): { usage: TokenUsage; costBasis: 'priced' | 'local' | 'unknown' } {
  const usage = (
    resp as
      | {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cached_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
          };
        }
      | undefined
  )?.usage;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  // Prompt-cache hits. The Responses API nests them under
  // `input_tokens_details`; some vendors flatten them onto `usage`, so read
  // both and fall back to 0 when neither is reported. This reads 0 for xAI
  // until a stable per-session cache key reaches `CompletionOptions`
  // (deferred in plan/uncompleted-tasks.md) — expected, not a bug.
  const cacheReadTokens = usage?.input_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0;

  // Codex model ids that the shared table knows price normally; the
  // rest resolve to 0 AND report `pricing.unknown_model`, so a
  // subscription-served model shows up as an acknowledged blind spot
  // rather than as a silent, unmarked zero.
  const costEstimate = estimateCost(model, { inputTokens, outputTokens });
  return {
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      estimatedCostUsd: costEstimate.costUsd,
      requestTokens,
    },
    costBasis: costEstimate.basis,
  };
}

/** `{code, message}` from a `response.failed` response's `error`, or an `error` event. */
function vendorError(value: unknown): { code: string | undefined; message: string } {
  const err = (typeof value === 'object' && value !== null ? value : {}) as {
    code?: unknown;
    message?: unknown;
  };
  return {
    code: typeof err.code === 'string' ? err.code : undefined,
    message: typeof err.message === 'string' ? err.message : '',
  };
}

// ---------------------------------------------------------------------------
// streamResponsesApi
// ---------------------------------------------------------------------------

/**
 * Stream the OpenAI Responses API endpoint, yielding `CompletionChunk`s.
 *
 * This is the raw transport: it issues the fetch, parses SSE events, and maps
 * each event to the Ethos `CompletionChunk` discriminated union. The caller is
 * responsible for building the `ResponsesApiBody`.
 */
export async function* streamResponsesApi(
  endpoint: string,
  token: string,
  body: ResponsesApiBody,
  signal?: AbortSignal,
  requestTokens?: { system: number; tools: number; messages: number },
  providerLabel?: string,
  retry?: TransientRetryOptions,
): AsyncIterable<CompletionChunk> {
  // This transport is shared by every provider that speaks the Responses API
  // (ARCHITECTURE.md:264-265), so the failure message must name the caller's
  // vendor — an xAI 401 reported as a Codex error sends the operator to the
  // wrong console. Callers pass their own label; with none, stay neutral.
  const apiLabel = providerLabel ? `${providerLabel} Responses API` : 'Responses API';

  const bodyStr = JSON.stringify(body);
  // UBP-030 — a 429/5xx/network failure is retried before the first byte only.
  const response = await fetchWithTransientRetry(
    () =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: bodyStr,
        signal,
      }),
    signal,
    retry,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ResponsesApiError(
      `${apiLabel} error ${response.status}: ${text || response.statusText}`,
      response.status,
      text,
    );
  }

  if (!response.body) {
    throw new Error(`${apiLabel} returned no body`);
  }

  // Track tool calls in flight for mapping deltas to tool IDs.
  let currentToolId = '';
  let hasToolCalls = false;
  // UBP-034 — a stream that closes before `response.completed` or a
  // max-tokens `response.incomplete` was cut off; it is not an answer.
  let sawTerminal = false;

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
        const item = payload.item as
          | { type?: string; id?: string; call_id?: string; name?: string }
          | undefined;
        const toolId = item?.call_id ?? item?.id;
        if (item?.type === 'function_call' && toolId && item.name) {
          currentToolId = toolId;
          hasToolCalls = true;
          yield { type: 'tool_use_start', toolCallId: toolId, toolName: item.name };
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
        const item = payload.item as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              arguments?: string;
            }
          | undefined;
        const toolId = item?.call_id ?? item?.id;
        if (item?.type === 'function_call' && toolId) {
          yield {
            type: 'tool_use_end',
            toolCallId: toolId,
            inputJson: item.arguments ?? '',
          };
          // Reset for the next tool call in the same response.
          currentToolId = '';
        }
        break;
      }

      case 'response.completed': {
        sawTerminal = true;
        yield {
          type: 'usage',
          ...usageFrom(payload.response, body.model, requestTokens),
          metadata: {},
        };
        yield {
          type: 'done',
          finishReason: hasToolCalls ? 'tool_use' : 'end_turn',
        };
        break;
      }

      // UBP-034 — a response cut off by the output cap is a max_tokens stop,
      // never a complete answer. Any other incomplete reason (content_filter,
      // or one added later) is refused as an error rather than delivered.
      case 'response.incomplete': {
        const resp = payload.response as { incomplete_details?: { reason?: unknown } } | undefined;
        const reason = resp?.incomplete_details?.reason;
        if (reason === 'max_output_tokens') {
          sawTerminal = true;
          yield {
            type: 'usage',
            ...usageFrom(payload.response, body.model, requestTokens),
            metadata: {},
          };
          yield { type: 'done', finishReason: 'max_tokens' };
          break;
        }
        const why = typeof reason === 'string' ? reason : 'unknown';
        throw new ResponsesApiError(
          `${apiLabel} response incomplete (${why}): the response was cut off before it finished`,
          undefined,
          sse.data,
          why,
        );
      }

      case 'response.failed': {
        const { code, message } = vendorError(
          (payload.response as { error?: unknown } | undefined)?.error,
        );
        throw new ResponsesApiError(
          `${apiLabel} response failed${code ? ` (${code})` : ''}: ${message || 'no detail'}`,
          undefined,
          sse.data,
          code,
        );
      }

      case 'error': {
        const { code, message } = vendorError(payload);
        throw new ResponsesApiError(
          `${apiLabel} stream error${code ? ` (${code})` : ''}: ${message || 'no detail'}`,
          undefined,
          sse.data,
          code,
        );
      }

      // Ignore other event types (response.created, response.in_progress, etc.)
    }
  }

  if (!sawTerminal) {
    throw new ResponsesApiError(
      `${apiLabel} stream ended without response.completed — the response was cut off`,
      undefined,
      '',
      'incomplete_stream',
    );
  }
}
