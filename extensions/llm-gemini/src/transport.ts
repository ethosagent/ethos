import { fetchWithTransientRetry, type TransientRetryOptions } from '@ethosagent/core';
import { estimateCost } from '@ethosagent/pricing';
import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  TokenUsage,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { flattenCompactionEnvelopes } from '@ethosagent/types';

export interface GeminiTransportConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** UBP-030 — pre-first-byte retry of a 429/5xx/network failure (`fetchWithTransientRetry`, packages/core/src/providers/transient-retry.ts). */
  retry?: TransientRetryOptions;
}

/**
 * State that must outlive one request, owned by `GeminiNativeProvider`.
 *
 * UBP-031 — Gemini's `functionCall` parts carry no id we can rely on, so one is
 * minted per part. The ids land in history and are replayed to every provider
 * a session later fails over to, so they must be unique across requests, not
 * just within one: the provider's seed + counter makes them so.
 *
 * UBP-032 (D5) — Gemini 3 attaches an opaque `thoughtSignature` to a
 * `functionCall` part and refuses the follow-up request unless that part is
 * sent back with it. The frozen `MessageContent` contract has no slot for it,
 * so the provider keeps it here, keyed by the minted tool-call id, and
 * `convertPart` re-attaches it. Process-lifetime only: after a restart a
 * signature from before the restart is gone.
 */
export interface GeminiStreamState {
  nextToolCallId: () => string;
  thoughtSignatures: Map<string, string>;
}

/** Bound on remembered signatures; the oldest is dropped first. */
export const MAX_THOUGHT_SIGNATURES = 2000;

/** A state for one-off callers of the bare transport: a random seed keeps ids unique. */
export function createGeminiStreamState(): GeminiStreamState {
  const seed = Math.random().toString(36).slice(2, 8);
  let counter = 0;
  return {
    nextToolCallId: () => `gemini-${seed}-${counter++}`,
    thoughtSignatures: new Map(),
  };
}

function rememberSignature(state: GeminiStreamState, id: string, signature: string): void {
  const map = state.thoughtSignatures;
  map.delete(id);
  map.set(id, signature);
  while (map.size > MAX_THOUGHT_SIGNATURES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export async function* streamGeminiGenerate(
  config: GeminiTransportConfig,
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  signal?: AbortSignal,
  state: GeminiStreamState = createGeminiStreamState(),
): AsyncGenerator<CompletionChunk> {
  const base = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;

  const bodyStr = JSON.stringify(buildGeminiBody(messages, tools, options, state));

  const response = await fetchWithTransientRetry(
    () =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyStr,
        signal,
      }),
    signal,
    config.retry,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  if (!response.body) throw new Error('Gemini response has no body');

  yield* parseGeminiSSE(response.body, config.model, state);
}

/** Exported for the request-body tests. */
export function buildGeminiBody(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  state: GeminiStreamState = createGeminiStreamState(),
): Record<string, unknown> {
  // Item 7 (D33) — a persisted server-compaction block reaches this provider
  // as its readable summary; the Anthropic-only encrypted half is dropped.
  const flattened = flattenCompactionEnvelopes(messages);
  // UBP-031 — `functionResponse.name` is the FUNCTION's name. A tool_result
  // block carries only the call id, so resolve it from the tool_use it answers.
  const toolNames = new Map<string, string>();
  for (const m of flattened) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name);
    }
  }
  const contents = flattened
    .filter((m) => m.role !== 'user' || typeof m.content === 'string' || m.content.length > 0)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts:
        typeof m.content === 'string'
          ? [{ text: m.content }]
          : m.content.map((c) => convertPart(c, toolNames, state.thoughtSignatures)),
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { topP: options.topP } : {}),
      ...(options.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
    },
  };

  if (options.system) {
    body.systemInstruction = { parts: [{ text: options.system }] };
  }

  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  return body;
}

function convertPart(
  c: { type: string; [key: string]: unknown },
  toolNames: ReadonlyMap<string, string>,
  signatures: ReadonlyMap<string, string>,
): Record<string, unknown> {
  switch (c.type) {
    case 'text':
      return { text: c.text };
    case 'tool_use': {
      // UBP-032 — the signature is a sibling of `functionCall` on the part,
      // sent back byte for byte.
      const signature = typeof c.id === 'string' ? signatures.get(c.id) : undefined;
      return {
        functionCall: { name: c.name, args: c.input },
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      };
    }
    case 'tool_result': {
      const id = String(c.tool_use_id);
      return {
        functionResponse: { name: toolNames.get(id) ?? id, response: { result: c.content } },
      };
    }
    // Gemini takes images and PDFs through the same `inlineData` part, keyed
    // by mime type. `document` shares the case: without it a PDF fell to the
    // default branch and reached the model as the literal text "undefined",
    // while the provider advertised `visionDocuments: true`.
    case 'image':
    case 'document':
      return { inlineData: { mimeType: c.mediaType, data: c.data } };
    default:
      return { text: String(c.text ?? '') };
  }
}

async function* parseGeminiSSE(
  body: ReadableStream<Uint8Array>,
  model: string,
  state: GeminiStreamState,
): AsyncGenerator<CompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const turn = { sawFunctionCall: false };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        const dataLine = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
        if (!dataLine) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(dataLine);
        } catch {
          continue; // Skip malformed JSON
        }
        yield* handleGeminiEvent(event, model, state, turn);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Map Gemini's `usageMetadata` onto `TokenUsage`, priced.
 *
 * `promptTokenCount` INCLUDES `cachedContentTokenCount`, so the cached slice is
 * subtracted before the input rate is applied — otherwise a cache hit is billed
 * twice, once at the input rate and once at the cache-read rate. The reported
 * token counts keep Gemini's own meaning; only the cost math splits them.
 */
function geminiUsage(
  meta: Record<string, number>,
  model: string,
): { usage: TokenUsage; costBasis: 'priced' | 'local' | 'unknown' } {
  const promptTokens = meta.promptTokenCount ?? 0;
  const outputTokens = meta.candidatesTokenCount ?? 0;
  const cacheReadTokens = meta.cachedContentTokenCount ?? 0;
  // Previously hardcoded to 0, which reported every Gemini turn as free.
  const costEstimate = estimateCost(model, {
    inputTokens: Math.max(promptTokens - cacheReadTokens, 0),
    outputTokens,
    cacheReadTokens,
  });
  return {
    usage: {
      inputTokens: promptTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      estimatedCostUsd: costEstimate.costUsd,
    },
    costBasis: costEstimate.basis,
  };
}

function* handleGeminiEvent(
  event: Record<string, unknown>,
  model: string,
  state: GeminiStreamState,
  turn: { sawFunctionCall: boolean },
): Generator<CompletionChunk> {
  const candidates = event.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates?.length) {
    const meta = event.usageMetadata as Record<string, number> | undefined;
    if (meta) {
      yield { type: 'usage', ...geminiUsage(meta, model) };
    }
    return;
  }

  const candidate = candidates[0];
  const content = candidate.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;

  if (parts) {
    for (const part of parts) {
      if (part.text !== undefined) {
        yield { type: 'text_delta', text: part.text as string };
      } else if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        // UBP-031 — one id per PART: two calls in one event used to share an
        // id, so the second's args landed on the first and the second vanished.
        const toolCallId = state.nextToolCallId();
        turn.sawFunctionCall = true;
        if (typeof part.thoughtSignature === 'string') {
          rememberSignature(state, toolCallId, part.thoughtSignature);
        }
        yield { type: 'tool_use_start', toolCallId, toolName: fc.name as string };
        const argsJson = JSON.stringify(fc.args ?? {});
        yield { type: 'tool_use_delta', toolCallId, partialJson: argsJson };
        yield { type: 'tool_use_end', toolCallId, inputJson: argsJson };
      }
    }
  }

  const finishReason = candidate.finishReason as string | undefined;
  if (finishReason) {
    // Gemini ends a function-calling turn with STOP; the calls are what the
    // turn asked for, so it is a tool_use stop.
    const reason =
      finishReason === 'STOP'
        ? turn.sawFunctionCall
          ? 'tool_use'
          : 'end_turn'
        : finishReason === 'MAX_TOKENS'
          ? 'max_tokens'
          : finishReason === 'SAFETY'
            ? 'end_turn'
            : 'end_turn';
    yield { type: 'done', finishReason: reason };
  }

  const meta = event.usageMetadata as Record<string, number> | undefined;
  if (meta) {
    yield { type: 'usage', ...geminiUsage(meta, model) };
  }
}
