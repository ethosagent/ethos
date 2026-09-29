import { estimateCost } from '@ethosagent/pricing';
import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  ToolDefinitionLite,
  ToolOrder,
} from '@ethosagent/types';
import { orderToolDefinitions } from '@ethosagent/types';
import type OpenAI from 'openai';
import { isGemini3Model, normalizeGeminiSchema, toOpenAIMessages } from './index';
import type { LocalOpenAiRuntime } from './runtime-classify';
import { sanitizeToolSchemaForGrammar } from './schema-sanitize';

// ---------------------------------------------------------------------------
// Shared Chat Completions streaming transport
// ---------------------------------------------------------------------------

export interface ChatCompletionsStreamParams {
  oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming;
  requestTokens?: { system: number; tools: number; messages: number };
  effectiveModel: string;
  /** Served by a local runtime (Ollama, vLLM, llama.cpp, LM Studio). Pricing
   *  reads this rather than guessing from the model name: `deepseek-r1` and
   *  `mistral` name both an Ollama pull and a paid hosted model, so the name
   *  alone cannot tell an intentional $0 from an unpriced one. */
  localRuntime?: boolean;
  /** B2 — the loop's client-minted per-LLM-call id, sent outbound on the
   *  `X-Client-Request-Id` header. Absent → no header is sent. */
  clientRequestId?: string;
  /** UBP-032 — receives a Gemini thought signature streamed on a tool call
   *  (`extra_content.google.thought_signature`), so the provider can replay it
   *  on the next request. Absent → signatures are not read. */
  onThoughtSignature?: (toolCallId: string, signature: string) => void;
}

/** A Gemini thought signature on a streamed tool-call delta, if present. The
 *  field is not in the SDK's delta type — narrow structural read, no `any`. */
function geminiThoughtSignature(toolCallDelta: unknown): string | undefined {
  const extra = (toolCallDelta as { extra_content?: { google?: { thought_signature?: unknown } } })
    .extra_content;
  const signature = extra?.google?.thought_signature;
  return typeof signature === 'string' && signature !== '' ? signature : undefined;
}

/** B2 — outbound correlation header. OpenAI, OpenRouter and the local runtimes
 *  all pass unknown `X-`-prefixed request headers through to their logs, so one
 *  header name works across every openai-compat dialect. */
const CLIENT_REQUEST_ID_HEADER = 'X-Client-Request-Id';

type StructuredOutputDialect = 'openai' | 'ollama' | 'vllm';

/** OpenAI's own Chat Completions host. */
export function isOpenAiFirstPartyUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * UBP-038 — OpenAI's reasoning families (o1/o3/o4…, gpt-5.x) refuse
 * `max_tokens` on Chat Completions ("Unsupported parameter") and take
 * `max_completion_tokens`. The model catalog carries no reasoning flag, so the
 * rule is the model id: a BARE id (no `vendor/` prefix, which is how an
 * aggregator such as OpenRouter names models and normalizes the parameter
 * itself) starting `o<digit>` or `gpt-5`. Copied in
 * apps/web-api/src/services/onboarding.service.ts for the onboarding probe;
 * change both together.
 */
export function isOpenAiReasoningModelId(model: string): boolean {
  return /^(?:o\d+|gpt-5)(?:[-.]|$)/i.test(model);
}

/**
 * Presence §4 — `CompletionOptions.effort` → Chat Completions `reasoning_effort`
 * (openai SDK `ChatCompletionCreateParamsBase.reasoning_effort`).
 *
 * Sent only for an OpenAI reasoning-family model id (`isOpenAiReasoningModelId`)
 * on api.openai.com. Everywhere else it is ignored and the body is unchanged:
 * OpenRouter and the other hosted dialects spell reasoning control their own
 * way, local runtimes do not read it, and whether the api-versions Azure is
 * called with accept it has not been verified (the same caution
 * `outputCapParam` applies to Azure), nor for the ids `acceptsReasoningEffort`
 * excludes. `off` maps to `low`: `none` and `minimal` exist only on some
 * reasoning generations, and `low` is the lowest every one of them accepts. Pinned by
 * `__tests__/reasoning-effort.test.ts`.
 */
function openAiReasoningEffort(
  options: CompletionOptions,
  model: string,
  openAiFirstParty: boolean | undefined,
): 'low' | 'medium' | 'high' | undefined {
  const effort = options.effort;
  if (effort === undefined || openAiFirstParty !== true) return undefined;
  if (!acceptsReasoningEffort(model)) return undefined;
  if (/^gpt-5-pro(?:-|$)/i.test(model)) return 'high';
  return effort === 'off' ? 'low' : effort;
}

/**
 * The reasoning-family ids (`isOpenAiReasoningModelId`) that take
 * `reasoning_effort`. Excluded: `gpt-5-chat*` (the non-reasoning ChatGPT
 * snapshot), `o1-mini` and `o1-preview` (predate the parameter). `gpt-5-pro`
 * takes only `high` (`openAiReasoningEffort`). An id outside the family sends
 * nothing. Pinned by `__tests__/reasoning-effort.test.ts`.
 */
function acceptsReasoningEffort(model: string): boolean {
  if (!isOpenAiReasoningModelId(model)) return false;
  return !/^(?:gpt-5(?:\.\d+)?-chat|o1-mini|o1-preview)(?:-|$)/i.test(model);
}

/**
 * Which output-cap parameter a request sends. `max_completion_tokens` for
 * OpenAI's own host (where it is the current name for every model and
 * `max_tokens` is deprecated) and for a reasoning-family model id on any
 * hosted endpoint; `max_tokens` everywhere else, so local runtimes and the
 * other hosted dialects keep byte-identical request bodies.
 *
 * Azure (this provider's `azure.com` branch, and @ethosagent/llm-azure, which
 * builds its body with `buildChatCompletionsParamsAsync`) follows the model-id
 * rule on the DEPLOYMENT name, because that is the only model id either sees:
 * a deployment named for a reasoning family (the portal's default name is the
 * model's) gets `max_completion_tokens`. A reasoning deployment under any other
 * name would be sent `max_tokens` and refused, so @ethosagent/llm-azure takes
 * `providers.<n>.outputCapParam` from config and passes it here as the
 * `outputCapParam` override, which wins over this rule (pinned by
 * extensions/llm-azure/src/__tests__/output-cap-param.test.ts). It is not sent
 * to every Azure deployment because no one has verified that every Azure
 * api-version (this branch pins 2024-08-01-preview) accepts it for the
 * non-reasoning models. Pinned by __tests__/max-completion-tokens.test.ts.
 */
export function outputCapParam(
  model: string,
  opts?: { openAiFirstParty?: boolean; localRuntime?: LocalOpenAiRuntime },
): 'max_tokens' | 'max_completion_tokens' {
  if (opts?.openAiFirstParty === true) return 'max_completion_tokens';
  if (opts?.localRuntime === undefined && isOpenAiReasoningModelId(model)) {
    return 'max_completion_tokens';
  }
  return 'max_tokens';
}

/**
 * §3 — forward a grammar-constrained JSON request built by
 * `structuredOutputOption` (@ethosagent/types). The caller sets
 * `providerOptions['openai-compat'].responseFormat = { name?, strict?, schema }`;
 * we map it to the provider dialect on the request body. Absent or malformed
 * (no `schema` object) → no field is set, so every existing call is unchanged.
 * The incoming value is caller data, so it is structurally guarded here.
 */
function applyStructuredOutput(
  oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  options: CompletionOptions,
  dialect: StructuredOutputDialect,
): void {
  const responseFormat = options.providerOptions?.['openai-compat']?.responseFormat;
  if (!responseFormat || typeof responseFormat !== 'object') return;
  const wrapper = responseFormat as Record<string, unknown>;
  const schema = wrapper.schema;
  if (!schema || typeof schema !== 'object') return;
  const jsonSchema = schema as Record<string, unknown>;
  const name = typeof wrapper.name === 'string' ? wrapper.name : 'response';
  const strict = typeof wrapper.strict === 'boolean' ? wrapper.strict : true;

  if (dialect === 'ollama') {
    // Ollama structured output: top-level `format` accepts a JSON schema.
    Object.assign(oaiParams, { format: jsonSchema });
  } else if (dialect === 'vllm') {
    // vLLM guided decoding: `guided_json` accepts a JSON schema.
    Object.assign(oaiParams, { guided_json: jsonSchema });
  } else {
    // OpenAI-compat standard: response_format json_schema.
    oaiParams.response_format = {
      type: 'json_schema',
      json_schema: { name, strict, schema: jsonSchema },
    };
  }
}

/**
 * Lane 4b(e) — wire `topK`/`minP` from the profile system to the request
 * body. `applySamplingDefaults` (packages/core/src/agent-loop/sampling.ts)
 * writes them into `providerOptions['openai-compat']`; before this they were
 * never read (dead config). Ollama and vLLM accept `top_k`/`min_p` as extra
 * body params on their OpenAI-compat endpoints. Hosted dialects (openai /
 * openrouter / gemini / groq / deepseek all map to 'openai') do NOT get them
 * — they would 400 or be ignored inconsistently, and the hosted golden
 * baselines must stay byte-identical. Same `Object.assign` extra-body
 * discipline as `applyStructuredOutput` above (the params are not in the
 * OpenAI SDK types).
 *
 * Post-review FIX 6 — the extras also fire for the lmstudio/llamacpp
 * classifications (both accept top_k/min_p on their OpenAI-compat endpoints
 * but fall through to the 'openai' response-format dialect), gated on the
 * FIX 2-hardened `localRuntime` so a hosted alias never gets them.
 */
function applySamplingExtras(
  oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  options: CompletionOptions,
  dialect: StructuredOutputDialect,
  localRuntime?: LocalOpenAiRuntime,
): void {
  const local =
    dialect === 'ollama' ||
    dialect === 'vllm' ||
    localRuntime === 'llamacpp' ||
    localRuntime === 'lmstudio';
  if (!local) return;
  const bag = options.providerOptions?.['openai-compat'];
  if (!bag) return;
  if (typeof bag.topK === 'number') Object.assign(oaiParams, { top_k: bag.topK });
  if (typeof bag.minP === 'number') Object.assign(oaiParams, { min_p: bag.minP });
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
  opts?: {
    gemini?: boolean;
    countTokens?: (msgs: Message[]) => Promise<number>;
    structuredOutputDialect?: StructuredOutputDialect;
    /** FIX 6 — hardened local-runtime classification; extends the sampling
     *  extras to lmstudio/llamacpp without touching response_format. */
    localRuntime?: LocalOpenAiRuntime;
    toolOrder?: ToolOrder;
    /** Lane 3(a) — llamacpp-class grammar sanitizing at this boundary (D7).
     *  Absent → schemas pass through untouched (hosted dialects, Anthropic). */
    toolSchemaProfile?: 'llamacpp';
    /** Lane 3(a) — receives one line per sanitizer transformation, naming the
     *  tool and the change. A drop is never silent. */
    onSchemaChange?: (message: string) => void;
    /** UBP-038 — the endpoint is api.openai.com (see `outputCapParam`). */
    openAiFirstParty?: boolean;
    /** V-CP-5 — an operator-forced output-cap parameter; wins over the
     *  `outputCapParam` rule. Set by @ethosagent/llm-azure from config. */
    outputCapParam?: 'max_tokens' | 'max_completion_tokens';
    /** UBP-032 — Gemini thought signatures to replay, keyed by tool-call id
     *  (see `toOpenAIMessages`). */
    thoughtSignatures?: ReadonlyMap<string, string>;
  },
): ChatCompletionsStreamParams {
  const oaiMessages = toOpenAIMessages(
    messages,
    options.system,
    opts?.thoughtSignatures
      ? {
          thoughtSignatures: opts.thoughtSignatures,
          signUnsigned: isGemini3Model(options.modelOverride ?? model),
        }
      : undefined,
  );

  // Lane 2a — deterministic ASCII-stable tool ordering at the serialization
  // boundary. Tool definitions ship ahead of the messages and are part of the
  // cacheable prefix (vLLM --enable-prefix-caching, llama.cpp --cache-reuse
  // hash it); registration order is not stable across restarts. The ordering
  // is a caching device, NOT a priority signal.
  const orderedTools = orderToolDefinitions(tools, opts?.toolOrder ?? 'stable');

  const oaiTools: OpenAI.Chat.ChatCompletionTool[] = orderedTools.map((t) => {
    let parameters = t.parameters;
    if (opts?.gemini) {
      parameters = normalizeGeminiSchema(parameters);
    } else if (opts?.toolSchemaProfile === 'llamacpp') {
      // Lane 3(a) — sanitize for the GBNF grammar compiler. Gated on the
      // llamacpp-class local dialect only; every transformation is surfaced
      // via onSchemaChange (logged by the provider, never silent).
      const sanitized = sanitizeToolSchemaForGrammar(t.name, parameters);
      for (const change of sanitized.changes) opts?.onSchemaChange?.(change);
      parameters = sanitized.schema;
    }
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters,
        // Lane 4b(g) — vLLM dialect ONLY (eng review D21). Without strict,
        // vLLM's `tool_choice: auto` does not constrain arguments at all.
        // Hosted dialects and other locals are unchanged (hosted golden
        // baselines stay byte-identical).
        ...(opts?.structuredOutputDialect === 'vllm' ? { strict: true } : {}),
      },
    };
  });

  const effectiveModel = options.modelOverride ?? model;
  const capParam =
    opts?.outputCapParam ??
    outputCapParam(effectiveModel, {
      ...(opts?.openAiFirstParty !== undefined ? { openAiFirstParty: opts.openAiFirstParty } : {}),
      ...(opts?.localRuntime !== undefined ? { localRuntime: opts.localRuntime } : {}),
    });
  const oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: effectiveModel,
    messages: oaiMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxTokens ? { [capParam]: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
  };
  const reasoningEffort = openAiReasoningEffort(options, effectiveModel, opts?.openAiFirstParty);
  if (reasoningEffort) oaiParams.reasoning_effort = reasoningEffort;

  const dialect = opts?.structuredOutputDialect ?? 'openai';
  applyStructuredOutput(oaiParams, options, dialect);
  applySamplingExtras(oaiParams, options, dialect, opts?.localRuntime);

  return {
    oaiParams,
    requestTokens: undefined,
    effectiveModel,
    localRuntime: opts?.localRuntime !== undefined,
    // B2 — carried beside the body, not in it: the id is a request HEADER, so
    // it never perturbs the byte-stable prefix the local caches hash.
    ...(options.requestId ? { clientRequestId: options.requestId } : {}),
  };
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
  opts?: {
    gemini?: boolean;
    countTokens?: (msgs: Message[]) => Promise<number>;
    structuredOutputDialect?: StructuredOutputDialect;
    localRuntime?: LocalOpenAiRuntime;
    toolOrder?: ToolOrder;
    toolSchemaProfile?: 'llamacpp';
    onSchemaChange?: (message: string) => void;
    openAiFirstParty?: boolean;
    outputCapParam?: 'max_tokens' | 'max_completion_tokens';
    thoughtSignatures?: ReadonlyMap<string, string>;
  },
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
  const stream = await client.chat.completions.create(params.oaiParams, {
    signal,
    ...(params.clientRequestId
      ? { headers: { [CLIENT_REQUEST_ID_HEADER]: params.clientRequestId } }
      : {}),
  });

  // Track streaming tool calls by index (OpenAI streams them as deltas)
  const pendingTools = new Map<number, { id: string; name: string; args: string }>();

  // Lane 4a(c) — empty/silent-completion guard state. Local runtimes (Ollama,
  // llama.cpp, LM Studio, …) can end the SSE stream with no `finish_reason` at
  // all — abort, OOM, or a malformed final chunk. Without a guard the generator
  // returns having yielded NOTHING, not even `done`, and the failure is silent.
  let sawFinishReason = false;
  let sawOutput = false;

  for await (const chunk of stream) {
    const choice = chunk.choices[0];

    // Usage chunk (comes on its own chunk when stream_options.include_usage=true)
    if (!choice && chunk.usage) {
      const costEstimate = estimateCost(
        params.effectiveModel,
        {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        },
        { localRuntime: params.localRuntime },
      );
      yield {
        type: 'usage',
        usage: {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: costEstimate.costUsd,
          requestTokens: params.requestTokens,
        },
        metadata: {},
        costBasis: costEstimate.basis,
      };
      continue;
    }

    if (!choice) continue;

    const delta = choice.delta;

    // Lane 4b(b) — reasoning passthrough. Reasoning models emit their
    // chain-of-thought in `delta.reasoning_content` (DeepSeek-R1, Qwen3 via
    // vLLM/Ollama) or `delta.reasoning` (OpenRouter). Neither field is in the
    // SDK's Delta type — narrow structural read, no `any`. Emitted as the
    // EXISTING thinking_delta chunk variant and kept out of the text stream.
    const reasoningDelta = delta as { reasoning_content?: unknown; reasoning?: unknown };
    const reasoning =
      typeof reasoningDelta.reasoning_content === 'string'
        ? reasoningDelta.reasoning_content
        : typeof reasoningDelta.reasoning === 'string'
          ? reasoningDelta.reasoning
          : undefined;
    if (reasoning) {
      sawOutput = true;
      yield { type: 'thinking_delta', thinking: reasoning };
    }

    if (delta.content) {
      sawOutput = true;
      yield { type: 'text_delta', text: delta.content };
    }

    // Stream tool call deltas
    for (const tc of delta.tool_calls ?? []) {
      sawOutput = true;
      const idx = tc.index;

      if (!pendingTools.has(idx)) {
        // First delta for this tool call — has id and name
        const id = tc.id ?? '';
        const name = tc.function?.name ?? '';
        pendingTools.set(idx, { id, name, args: '' });
        yield { type: 'tool_use_start', toolCallId: id, toolName: name };
      }

      const pending = pendingTools.get(idx);
      if (pending && params.onThoughtSignature) {
        const signature = geminiThoughtSignature(tc);
        if (signature !== undefined) params.onThoughtSignature(pending.id, signature);
      }
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
      sawFinishReason = true;
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

  // Lane 4a(c) — the stream ended without ever carrying a `finish_reason`.
  // Unconditional across every dialect (universal bugfix per plan §2):
  //   - Nothing was streamed at all → name the failure. CompletionChunk has no
  //     error variant; the provider contract is to THROW, and AgentLoop's
  //     stream step surfaces it as an `error` AgentEvent (code `llm_error`).
  //   - Tool-call deltas were MID-FLIGHT → THROW (post-review FIX 4). A
  //     stream that dies mid-argument leaves silently truncated JSON;
  //     flushing it as a complete `tool_use_end` would let downstream
  //     json-repair close the braces and EXECUTE a mutating tool on
  //     truncated args. A thrown error is recoverable; a wrong execution
  //     is not.
  //   - Pure text WAS streamed (no pending tools) → the output is real, only
  //     the terminal chunk was lost. End the turn cleanly so the text isn't
  //     thrown away: synthesize `done`.
  if (!sawFinishReason) {
    if (!sawOutput) {
      throw new Error(
        `model ${params.effectiveModel} returned no output — the stream ended without a ` +
          'finish_reason (the runtime may have aborted, hit OOM, or dropped the final chunk)',
      );
    }
    if (pendingTools.size > 0) {
      const names = [...pendingTools.values()].map((tc) => tc.name || '(unnamed)').join(', ');
      throw new Error(
        `model ${params.effectiveModel}: stream ended without finish_reason while tool-call ` +
          `arguments were streaming (${names}) — refusing to execute a possibly truncated tool call`,
      );
    }
    yield { type: 'done', finishReason: 'end_turn' };
  }
}
