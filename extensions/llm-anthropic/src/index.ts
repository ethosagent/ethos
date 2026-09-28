import Anthropic from '@anthropic-ai/sdk';
import {
  type AuthProfile,
  type CompletionChunk,
  type CompletionOptions,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  decodeCompactionEnvelope,
  type FailoverReason,
  flattenCompactionEnvelopes,
  type LLMProvider,
  type Message,
  type MessageContent,
  orderToolDefinitions,
  type ProviderCapabilities,
  SERVER_COMPACTION_REJECTED_WARNING,
  type ToolDefinitionLite,
  type ToolOrder,
} from '@ethosagent/types';
import { modelRejectionMessage } from './model-rejection';
import { reduceToolSchemas } from './tool-schema';
import { type AnthropicStreamParams, streamAnthropicMessages } from './transport';

export { modelRejectionMessage } from './model-rejection';
export { attributeToolSchemaBytes, reduceToolSchemas } from './tool-schema';
export { streamAnthropicMessages } from './transport';
export type { AnthropicStreamParams };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Lane 2a — tool-definition ordering at the serialization boundary.
   *  Default `'stable'` (deterministic ASCII sort). `'insertion'` is a
   *  temporary rollback lever; removal tracked in plan/uncompleted-tasks.md. */
  toolOrder?: ToolOrder;
  /** Test seam — custom fetch handed to the Anthropic SDK client. Used by the
   *  golden request-body harness to capture exact wire bytes. Absent → the
   *  SDK's default fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Per-request deadline in milliseconds, handed to the Anthropic SDK client.
   *  The same operator key `requestTimeoutMs` that `OpenAICompatProvider`
   *  honours. Absent → `DEFAULT_LLM_REQUEST_TIMEOUT_MS` (20 minutes),
   *  overriding the SDK's own 10-minute default. `0` is honoured as "no
   *  deadline". */
  requestTimeoutMs?: number;
  /** SDK retry count, the same operator key `maxRetries` `OpenAICompatProvider`
   *  honours. Wiring sets `0` on a hop in a provider chain so failover is not
   *  delayed by `retry-after`-honouring retries. Absent → the SDK's own default. */
  maxRetries?: number;
  /** UBP-033 — the model profile's output cap (`maxOutputTokens`, threaded by
   *  wiring from the model catalog / `models.<provider>/<model>` config). A
   *  per-call `CompletionOptions.maxTokens` wins; absent both →
   *  `DEFAULT_MAX_OUTPUT_TOKENS`. Applies to `model` only. */
  maxOutputTokens?: number;
  /** The output cap for a `CompletionOptions.modelOverride` that names a
   *  model other than `model` (a personality role, think_deeper). Wiring
   *  resolves it from the same catalog + config merge as `maxOutputTokens`.
   *  Absent, or `undefined` for that model → `DEFAULT_MAX_OUTPUT_TOKENS`,
   *  never `maxOutputTokens`: the configured model's cap can exceed the
   *  override's (Opus 128000 vs Haiku 4.5 64000), which the API refuses. */
  maxOutputTokensFor?: (model: string) => number | undefined;
  /** The context window of `model` — what `maxContextTokens` reports and the
   *  local compaction gate measures against. Wiring resolves it with the
   *  window precedence (`contextWindow` config > model catalog, the
   *  `resolveContextWindow` call in `createLLMFromRegistry`). Absent →
   *  `anthropicContextTokens(model)`, the 200K fallback. */
  maxContextTokens?: number;
  /** The context window of a `CompletionOptions.modelOverride` naming another
   *  model, from the same catalog. Used to scale the server-compaction trigger
   *  down for an override with a smaller window. Absent, or `undefined` for
   *  that model → `anthropicContextTokens(override)`. */
  maxContextTokensFor?: (model: string) => number | undefined;
  /** Item 7 (D32) — server-side compaction, from `providers.<n>.serverCompaction`
   *  (wiring computes `triggerTokens`: `serverCompactionTriggerTokens`, else
   *  the local compaction gate's own threshold). `triggerCapFor` is the most
   *  the trigger may be for a `modelOverride` to another model (wiring: that
   *  model's own gate threshold); see `triggerFor`. Absent → never sent. */
  serverCompaction?: ServerCompactionConfig;
}

export interface ServerCompactionConfig {
  triggerTokens: number;
  triggerCapFor?: (model: string) => number | undefined;
}

/** Output cap when neither the call nor the model profile names one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8096;

/**
 * UBP-037 — bounded retry of an in-stream overloaded/rate-limit error. The SDK
 * retries a 429/529 HTTP response itself, but an SSE `error` event after HTTP
 * 200 reaches us as an `APIError` with no status that no SDK retry sees. Up to
 * 3 attempts, 500ms then 1500ms (+ up to 25% jitter) — the same shape as the
 * chain's pinned retry (`PINNED_MAX_ATTEMPTS`, packages/core/src/providers/
 * chained-provider.ts). Only while nothing has been yielded (a second stream
 * after a chunk would splice two answers), never after an abort, and not on a
 * chain hop (`maxRetries: 0`), where the chain's failover is the retry policy.
 */
const IN_STREAM_MAX_ATTEMPTS = 3;
const IN_STREAM_BASE_DELAY_MS = 500;
const IN_STREAM_BACKOFF_FACTOR = 3;
const IN_STREAM_JITTER_RATIO = 0.25;

/** An SSE `error` event the SDK raised mid-stream: status-less, typed by body. */
function inStreamErrorType(err: unknown): string | undefined {
  if (!(err instanceof Anthropic.APIError) || err.status !== undefined) return undefined;
  if (err.type) return err.type;
  if (/overloaded_error/.test(err.message)) return 'overloaded_error';
  if (/rate_limit_error/.test(err.message)) return 'rate_limit_error';
  return undefined;
}

function isTransientStreamError(err: unknown): boolean {
  const type = inStreamErrorType(err);
  return type === 'overloaded_error' || type === 'rate_limit_error';
}

function inStreamRetryDelayMs(retry: number): number {
  const base = IN_STREAM_BASE_DELAY_MS * IN_STREAM_BACKOFF_FACTOR ** (retry - 1);
  return base + Math.random() * base * IN_STREAM_JITTER_RATIO;
}

/** Resolves after `ms`, or rejects the moment `signal` fires. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The smallest trigger the provider sends. The figure comes from Anthropic's
 * API documentation ("Compaction at a token threshold",
 * platform.claude.com/docs/en/build-with-claude/compaction-threshold: minimum
 * 50,000 input tokens), NOT from SDK 0.120.0, whose `BetaCompact20260112Edit`
 * documents only the 150,000 default. A lower configured value is RAISED to
 * this floor, never rejected (`buildParams` in `AnthropicProvider.complete`;
 * pinned by __tests__/server-compaction.test.ts, "raises a trigger below").
 */
export const SERVER_COMPACTION_MIN_TRIGGER_TOKENS = 50_000;
/** Beta header for the `compact_20260112` edit — NOT `context-management-2025-06-27`,
 *  which gates only the clear_* context-editing strategies. */
export const SERVER_COMPACTION_BETA = 'compact-2026-01-12';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The FALLBACK window for a Claude model the caller has no window for: the
 *  documented windows live in the model catalog (`MODEL_CATALOG` in
 *  packages/wiring/src/model-catalog.ts — 1M for current models, 200K for
 *  Haiku 4.5) and reach the provider as `AnthropicProviderConfig.maxContextTokens`
 *  / `maxContextTokensFor`. 200K is the smallest window a current Claude model
 *  has, so an unknown id is never gated above what it can take. */
export function anthropicContextTokens(_model: string): number {
  return 200_000;
}

function isThinkingModel(model: string): boolean {
  return (
    model.includes('claude-3-7') ||
    model.includes('claude-opus-4') ||
    model.includes('claude-sonnet-4')
  );
}

function classifyError(err: unknown): FailoverReason {
  if (err instanceof Anthropic.AuthenticationError) return 'auth';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limit';
  // APIStatusError covers 5xx and other HTTP errors
  if (err instanceof Anthropic.APIError) {
    const status = (err as { status?: number }).status;
    if (status === 529) return 'overloaded';
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limit';
    // UBP-037 — an SSE `error` event mid-stream carries no status, only the
    // body's type (`inStreamErrorType`).
    const type = inStreamErrorType(err);
    if (type === 'overloaded_error') return 'overloaded';
    if (type === 'rate_limit_error') return 'rate_limit';
  }
  return 'unknown';
}

/**
 * A 400 that a request WITHOUT the compaction edit could get past: the beta or
 * the edit was refused (unsupported model, beta not enabled, bad trigger).
 * A prompt-too-long 400 is excluded — it is a context overflow, and a retry
 * without compaction would only overflow again.
 */
function isCompactionRejection(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    !/prompt is too long/i.test(err.message)
  );
}

// Convert our Message[] into Anthropic's MessageParam[].
//
// Item 7 — with `compactionBlocks` (server compaction on for this request) a
// persisted compaction envelope becomes a `compaction` block param, one
// message per envelope so `cacheBreakpoints` indices still line up;
// `encrypted_content` goes back byte for byte. Without it the caller flattens
// envelopes to text first (`flattenCompactionEnvelopes`), as every other
// provider does.
export function toAnthropicMessages(
  messages: Message[],
  opts?: { compactionBlocks?: boolean },
): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      const envelope = opts?.compactionBlocks ? decodeCompactionEnvelope(msg.content) : null;
      if (envelope && msg.role === 'assistant') {
        // `compaction` is a beta block type the non-beta `ContentBlockParam`
        // union does not list; the request carrying it goes to the beta
        // endpoint (`streamAnthropicMessages`).
        const block = {
          type: 'compaction',
          content: envelope.content,
          encrypted_content: envelope.encryptedContent,
        } as unknown as Anthropic.ContentBlockParam;
        return { role: 'assistant', content: [block] };
      }
      return { role: msg.role, content: msg.content };
    }
    const blocks = msg.content.map(toAnthropicBlock);
    return { role: msg.role, content: blocks };
  });
}

function toAnthropicBlock(block: MessageContent): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      };
    case 'document':
      // Anthropic PDF support (Base64PDFSource)
      return {
        type: 'document',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      };
    default: {
      // Exhaustiveness guard — adding a new MessageContent variant without
      // teaching this mapper about it is a compile error, not silent fall-
      // through. The `never` cast surfaces the gap at the source.
      const _exhaustive: never = block;
      throw new Error(`unhandled MessageContent type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// context_compression F2 — place `cache_control` markers on message-history
// breakpoints. Anthropic allows at most 4 markers total (system + messages);
// `maxAllowed` is what remains after the system prompt. Indices are clamped to
// the message list and de-duplicated. When there are more breakpoints than
// slots, the *shallowest* ones are dropped: caching pays off on the largest
// stable prefix, so the deepest boundaries are the ones worth keeping. The
// marker lands on the last content block of the message so the cached prefix
// ends exactly at that message boundary.
export function applyMessageCacheBreakpoints(
  messages: Anthropic.MessageParam[],
  breakpoints: number[],
  maxAllowed: number,
): void {
  if (maxAllowed <= 0) return;
  const sorted = [...new Set(breakpoints)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < messages.length)
    .sort((a, b) => a - b);
  // Keep the deepest `maxAllowed` boundaries, still applied in ascending order.
  const valid = sorted.slice(Math.max(0, sorted.length - maxAllowed));
  for (const idx of valid) {
    const msg = messages[idx];
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
      continue;
    }
    const last = msg.content[msg.content.length - 1];
    // Every block our `toAnthropicBlock` emits (text / tool_use / tool_result)
    // carries `cache_control`, but the SDK's `ContentBlockParam` union also
    // includes thinking blocks that do not — narrow via a structural cast.
    if (last) {
      (last as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = {
        type: 'ephemeral',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = true;
  readonly supportsThinking: boolean;
  readonly supportsVision = { images: true, documents: true };
  readonly supportsCacheBreakpoints = true;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'real';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: true,
      visionDocuments: true,
      thinking: this.supportsThinking,
      promptCaching: true,
      cacheBreakpoints: true,
      systemPromptStyle: 'top-level',
      tokenCounting: 'real',
      // The cap `complete` sends when the call names none. The compaction gate
      // reserves it from the window (`evaluateGate`,
      // packages/core/src/agent-loop/compaction.ts), so the history it admits
      // plus this output fits. Pinned by __tests__/context-window-stop.test.ts.
      maxOutputTokens: this.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      contractVersion: 1,
    };
  }

  /** UBP-033 — the profile's output cap, when wiring passed one. */
  readonly maxOutputTokens: number | undefined;
  /** The per-model cap resolver for a `modelOverride`, when wiring passed one. */
  readonly maxOutputTokensFor: ((model: string) => number | undefined) | undefined;
  /** The per-model window resolver for a `modelOverride`, when wiring passed one. */
  readonly maxContextTokensFor: ((model: string) => number | undefined) | undefined;

  private readonly client: Anthropic;
  private readonly toolOrder: ToolOrder;
  /** UBP-037 — 1 on a chain hop (`maxRetries: 0`). */
  private readonly inStreamAttempts: number;
  private readonly serverCompaction: ServerCompactionConfig | undefined;

  constructor(config: AnthropicProviderConfig) {
    this.model = config.model;
    // An explicitly configured `requestTimeoutMs` always wins, including `0`
    // (the SDK reads that as no deadline), which is why this is `??` and not a
    // truthiness test. Absent → DEFAULT_LLM_REQUEST_TIMEOUT_MS (20 minutes),
    // double `BaseAnthropic.DEFAULT_TIMEOUT`.
    //
    // Two things about what this bounds on THIS provider. First, `complete()`
    // always streams (`streamAnthropicMessages` calls `client.messages.stream`),
    // and for a streaming body the SDK arms its timer around `fetch` and clears
    // it once the response headers arrive — so this is a time-to-headers
    // deadline, not a stream-duration one. Second, setting it at all changes
    // which SDK branch runs for a NON-streaming POST: `messages.create` only
    // calls `calculateNonstreamingTimeout` when the client option is absent, so
    // an explicit value also lifts that helper's "Streaming is required for
    // operations that may take longer than 10 minutes" throw. The only
    // non-streaming call here is `countTokens`, which returns in well under
    // either bound. Asserted by client-timeout.test.ts.
    this.client = new Anthropic({
      apiKey: config.apiKey,
      timeout: config.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
    });
    this.maxContextTokens =
      config.maxContextTokens !== undefined && config.maxContextTokens > 0
        ? config.maxContextTokens
        : anthropicContextTokens(config.model);
    this.maxContextTokensFor = config.maxContextTokensFor;
    this.supportsThinking = isThinkingModel(config.model);
    this.toolOrder = config.toolOrder ?? 'stable';
    this.serverCompaction = config.serverCompaction;
    this.maxOutputTokens = config.maxOutputTokens;
    this.maxOutputTokensFor = config.maxOutputTokensFor;
    this.inStreamAttempts = config.maxRetries === 0 ? 1 : IN_STREAM_MAX_ATTEMPTS;
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    // UBP-037 — see `IN_STREAM_MAX_ATTEMPTS`. Pinned by
    // __tests__/output-cap-and-stream-retry.test.ts.
    for (let attempt = 1; ; attempt++) {
      let yielded = false;
      try {
        for await (const chunk of this.completeOnce(messages, tools, options)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        const retry =
          !yielded &&
          !options.abortSignal?.aborted &&
          attempt < this.inStreamAttempts &&
          isTransientStreamError(err);
        if (!retry) throw err;
        await sleepUnlessAborted(inStreamRetryDelayMs(attempt), options.abortSignal);
      }
    }
  }

  /**
   * The server-compaction trigger for `model`. The configured trigger is sized
   * for `this.model`'s window. A `modelOverride` to another model keeps it when
   * it fits that model and is clamped only when it is larger: `min(trigger,
   * triggerCapFor(model))`, the cap wiring resolves as that model's own gate
   * threshold. So an Opus-configured provider routed to Haiku 4.5 does not send
   * an 800K trigger to a 200K model, and an explicit 150K trigger stays 150K
   * rather than being scaled to 30K. Without a cap resolver (a provider built
   * outside wiring) a smaller-window override gets the same fraction of its
   * window instead. Pinned by
   * packages/wiring/src/__tests__/anthropic-context-window-catalog.test.ts.
   */
  private triggerFor(model: string, trigger: number): number {
    if (model === this.model) return trigger;
    const cap = this.serverCompaction?.triggerCapFor?.(model);
    if (cap !== undefined) return Math.min(trigger, cap);
    const window = this.maxContextTokensFor?.(model) ?? anthropicContextTokens(model);
    if (window >= this.maxContextTokens) return trigger;
    return Math.floor((trigger * window) / this.maxContextTokens);
  }

  private async *completeOnce(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const systemBlocks: Anthropic.TextBlockParam[] | undefined = options.system
      ? [
          {
            type: 'text',
            text: options.system,
            ...(options.cacheSystemPrompt ? { cache_control: { type: 'ephemeral' } } : {}),
          },
        ]
      : undefined;

    // Item 7 — the history as one attempt sends it. With server compaction a
    // persisted envelope is a `compaction` block; without it (off, or the
    // retry after a rejected edit) envelopes flatten to text, and message
    // breakpoints are dropped when that moved indices.
    const buildMessages = (compactionBlocks: boolean): Anthropic.MessageParam[] => {
      const source = compactionBlocks ? messages : flattenCompactionEnvelopes(messages);
      const out = toAnthropicMessages(source, { compactionBlocks });
      // F2 — message-history cache breakpoints. The system prompt, when cached,
      // consumes one of Anthropic's 4 `cache_control` slots; the rest are
      // available for message-level breakpoints.
      if (options.cacheBreakpoints && options.cacheBreakpoints.length > 0 && source === messages) {
        const systemCached = systemBlocks !== undefined && options.cacheSystemPrompt === true;
        applyMessageCacheBreakpoints(out, options.cacheBreakpoints, 4 - (systemCached ? 1 : 0));
      }
      return out;
    };

    // Lane 2a — deterministic ASCII-stable tool ordering at the serialization
    // boundary. Tool definitions ship ahead of the messages and are part of
    // the cacheable prefix; registration order is not stable across restarts.
    // The ordering is a caching device, NOT a priority signal.
    const orderedTools = orderToolDefinitions(tools, this.toolOrder);

    // Phase 5 — trim the fixed tool-schema cost at the serialization boundary:
    // strip unused `$defs` and normalize description whitespace. Safe/lossless
    // by default; `requestTokens.tools` below then reflects the reduced size.
    const anthropicTools: Anthropic.Tool[] = reduceToolSchemas(orderedTools).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    // Per-slice token computation (P1 observability) — best-effort, never blocks the call.
    let requestTokens: { system: number; tools: number; messages: number } | undefined;
    try {
      const systemText = options.system ?? '';
      const toolsText = anthropicTools.length > 0 ? JSON.stringify(anthropicTools) : '';
      const [sysTk, toolsTk, msgTk] = await Promise.all([
        systemText ? this.countTokens([{ role: 'user', content: systemText }]) : 0,
        toolsText ? this.countTokens([{ role: 'user', content: toolsText }]) : 0,
        this.countTokens(messages),
      ]);
      requestTokens = { system: sysTk, tools: toolsTk, messages: msgTk };
    } catch {
      // Best-effort: if token counting fails, requestTokens stays undefined.
    }

    const effectiveModel = options.modelOverride ?? this.model;
    // The profile cap is per model: an override to another model takes that
    // model's cap (or the default), never the configured model's. Pinned by
    // __tests__/output-cap-and-stream-retry.test.ts ('max_tokens follows …').
    const profileCap =
      effectiveModel === this.model
        ? this.maxOutputTokens
        : this.maxOutputTokensFor?.(effectiveModel);

    const buildParams = (serverCompaction: boolean): AnthropicStreamParams => ({
      model: effectiveModel,
      max_tokens: options.maxTokens ?? profileCap ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: buildMessages(serverCompaction),
      ...(systemBlocks ? { system: systemBlocks } : {}),
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(isThinkingModel(effectiveModel) && options.thinkingBudget && options.thinkingBudget > 0
        ? { thinking: { type: 'enabled' as const, budget_tokens: options.thinkingBudget } }
        : {}),
      ...(serverCompaction && this.serverCompaction
        ? {
            betas: [SERVER_COMPACTION_BETA],
            context_management: {
              edits: [
                {
                  type: 'compact_20260112' as const,
                  trigger: {
                    type: 'input_tokens' as const,
                    value: Math.max(
                      SERVER_COMPACTION_MIN_TRIGGER_TOKENS,
                      this.triggerFor(effectiveModel, this.serverCompaction.triggerTokens),
                    ),
                  },
                },
              ],
            },
          }
        : {}),
      requestTokens,
    });

    try {
      if (!this.serverCompaction) {
        yield* streamAnthropicMessages(this.client, buildParams(false), options.abortSignal);
        return;
      }
      let yielded = false;
      try {
        for await (const chunk of streamAnthropicMessages(
          this.client,
          buildParams(true),
          options.abortSignal,
        )) {
          yielded = true;
          yield chunk;
        }
      } catch (err) {
        // D32 failure mode — the API refused the beta or the edit. Retry the
        // same request ONCE without it. The warning goes out only once the
        // retry streams, so a chain can still fail over if the retry fails
        // before its first chunk; core reads it to record
        // `llm.server_compaction_rejected` and to let local compaction run for
        // the rest of the turn. Pinned by __tests__/server-compaction.test.ts.
        if (yielded || options.abortSignal?.aborted || !isCompactionRejection(err)) throw err;
        let warned = false;
        for await (const chunk of streamAnthropicMessages(
          this.client,
          buildParams(false),
          options.abortSignal,
        )) {
          if (!warned) {
            warned = true;
            yield { type: 'warning', message: SERVER_COMPACTION_REJECTED_WARNING };
          }
          yield chunk;
        }
      }
    } catch (err) {
      // V8 — a model rejection reads as a bare vendor error and nothing else.
      // Keep the vendor's body verbatim, add the model id and the fix. Every
      // other error, and every rejection the narrow predicate does not match,
      // passes through exactly as before. The sibling is the codex 400 path
      // (`extensions/llm-codex/src/index.ts`).
      if (err instanceof Anthropic.APIError) {
        // The SDK parses the body before we ever see it, so this is the only
        // form of it available; it is also the form the SDK's own message
        // carries, so nothing is lost against the error this replaces.
        const rejection = modelRejectionMessage(
          err.status,
          JSON.stringify(err.error),
          effectiveModel,
        );
        if (rejection) throw new Error(rejection, { cause: err });
      }
      throw err;
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    const result = await this.client.messages.countTokens({
      model: this.model,
      messages: toAnthropicMessages(flattenCompactionEnvelopes(messages)),
    });
    return result.input_tokens;
  }
}

// ---------------------------------------------------------------------------
// AuthRotatingProvider — rotates API keys on auth/rate-limit failures
// ---------------------------------------------------------------------------

export class AuthRotatingProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly supportsCaching = true;

  private readonly providers: AnthropicProvider[];
  private current = 0;

  constructor(
    profiles: AuthProfile[],
    model: string,
    opts?: {
      toolOrder?: ToolOrder;
      requestTimeoutMs?: number;
      serverCompaction?: ServerCompactionConfig;
      /** UBP-033 — the model profile's output cap, for every pooled key. */
      maxOutputTokens?: number;
      /** Per-model cap for a `modelOverride`, for every pooled key. */
      maxOutputTokensFor?: (model: string) => number | undefined;
      /** The model's context window, for every pooled key. */
      maxContextTokens?: number;
      /** Per-model window for a `modelOverride`, for every pooled key. */
      maxContextTokensFor?: (model: string) => number | undefined;
    },
  ) {
    const sorted = [...profiles].sort((a, b) => b.priority - a.priority);
    this.providers = sorted.map(
      (p) =>
        new AnthropicProvider({
          apiKey: p.apiKey,
          model,
          baseUrl: p.baseUrl,
          ...(opts?.toolOrder ? { toolOrder: opts.toolOrder } : {}),
          // `!== undefined`, not truthiness — an explicit `0` must reach the
          // pooled providers rather than falling back to the default.
          ...(opts?.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: opts.requestTimeoutMs }
            : {}),
          ...(opts?.serverCompaction ? { serverCompaction: opts.serverCompaction } : {}),
          ...(opts?.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
          ...(opts?.maxOutputTokensFor ? { maxOutputTokensFor: opts.maxOutputTokensFor } : {}),
          ...(opts?.maxContextTokens !== undefined
            ? { maxContextTokens: opts.maxContextTokens }
            : {}),
          ...(opts?.maxContextTokensFor ? { maxContextTokensFor: opts.maxContextTokensFor } : {}),
        }),
    );
    if (this.providers.length === 0) throw new Error('AuthRotatingProvider: no profiles provided');
  }

  get model(): string {
    return this.providers[this.current]?.model ?? '';
  }

  get maxContextTokens(): number {
    return this.providers[this.current]?.maxContextTokens ?? anthropicContextTokens(this.model);
  }

  get supportsThinking(): boolean {
    return this.providers[this.current]?.supportsThinking ?? false;
  }

  /**
   * Only the output cap the pooled keys send, so the compaction gate reserves
   * it (`evaluateGate`, packages/core/src/agent-loop/compaction.ts) as it does
   * for a single `AnthropicProvider`. The pool has never advertised vision or
   * the other capabilities, and still does not: forwarding them would change
   * how a rotation deployment inlines attachments, which is a separate change.
   * Pinned by __tests__/context-window-stop.test.ts.
   */
  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      maxOutputTokens:
        this.providers[this.current]?.capabilities.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const startIdx = this.current;

    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const provider = this.providers[this.current];
      let yieldedAny = false;
      try {
        if (!provider) throw new Error('AuthRotatingProvider: missing provider slot');
        for await (const chunk of provider.complete(messages, tools, options)) {
          yieldedAny = true;
          yield chunk;
        }
        return;
      } catch (err) {
        // Once the consumer has seen any chunk, failing over to a different
        // provider would emit a fresh stream from the start and corrupt the
        // assistant turn. Propagate the error instead.
        //
        // An aborted turn is the same refusal for a different reason: the caller
        // stopped, so there is no failure to route around and nothing waiting for
        // a second stream. Stated explicitly rather than left to `classifyError`
        // returning 'unknown' for `APIUserAbortError` — a fallthrough is not a
        // decision, and an abort that races the platform's own 429 would rotate.
        // Same guard as `ChainedProvider` (packages/core/src/providers/chained-provider.ts);
        // pinned by `__tests__/auth-rotation-abort.test.ts`.
        if (yieldedAny || options.abortSignal?.aborted) throw err;

        const reason = classifyError(err);
        if (reason === 'auth' || reason === 'rate_limit' || reason === 'overloaded') {
          const next = (this.current + 1) % this.providers.length;
          if (next === startIdx) throw err; // full rotation exhausted
          this.current = next;
          continue;
        }
        throw err;
      }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    return this.providers[this.current]?.countTokens(messages) ?? Promise.resolve(0);
  }
}

// ---------------------------------------------------------------------------
// First-party plugin activation (§9.2 — dogfooding the plugin SDK)
// ---------------------------------------------------------------------------

import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';

export const PROVIDER_CONTRACT_MAJOR = 3;

/** Narrow an untyped factory-config resolver so it can only yield a positive
 *  number (an output cap or a context window). */
function numberResolver(fn: unknown): ((model: string) => number | undefined) | undefined {
  if (typeof fn !== 'function') return undefined;
  return (model) => {
    const n: unknown = fn(model);
    return typeof n === 'number' && n > 0 ? n : undefined;
  };
}

export const anthropicFactory: LLMProviderFactory = async ({ config: cfg, secrets, logger }) => {
  const secretKey = await secrets.get('providers/anthropic/apiKey');
  const apiKey = secretKey ?? (cfg.apiKey as string);
  if (secretKey === null && cfg.apiKey) {
    logger.warn(
      'Using plaintext apiKey from config for anthropic; migrate to the secret store: ethos secrets set providers/anthropic/apiKey <key>',
    );
  }
  const capFor = numberResolver(cfg.maxOutputTokensFor);
  const windowFor = numberResolver(cfg.maxContextTokensFor);
  const triggerCapFor = numberResolver(cfg.serverCompactionTriggerCapFor);
  return new AnthropicProvider({
    apiKey,
    model: cfg.model as string,
    // Per-request deadline threaded from config, the same key and the same
    // shape `openaiCompatFactory` uses. Absent → the provider's 20-minute
    // default.
    ...(typeof cfg.requestTimeoutMs === 'number' ? { requestTimeoutMs: cfg.requestTimeoutMs } : {}),
    // Retry count threaded from wiring (`0` on a chain hop). Absent → SDK default.
    ...(typeof cfg.maxRetries === 'number' ? { maxRetries: cfg.maxRetries } : {}),
    // UBP-033 — the model profile's output cap (`profile.maxOutputTokens`,
    // `createLLMFromRegistry` in packages/wiring; the model catalog records
    // each Claude model's documented cap). Absent → 8096.
    ...(typeof cfg.maxOutputTokens === 'number' ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
    // The same resolution for a `modelOverride` to another model. Whatever
    // the resolver returns is checked, so a non-number never reaches the wire.
    ...(capFor ? { maxOutputTokensFor: capFor } : {}),
    // The resolved context window (`createLLMFromRegistry`: `contextWindow`
    // config > model catalog) and the same lookup for a `modelOverride`.
    // Absent → `anthropicContextTokens`, the 200K fallback.
    ...(typeof cfg.maxContextTokens === 'number' ? { maxContextTokens: cfg.maxContextTokens } : {}),
    ...(windowFor ? { maxContextTokensFor: windowFor } : {}),
    // Lane 2a — tool-ordering escape hatch threaded from config; invalid
    // values fall through to the 'stable' default.
    ...(cfg.toolOrder === 'insertion' || cfg.toolOrder === 'stable'
      ? { toolOrder: cfg.toolOrder }
      : {}),
    // Item 7 — `providers.<n>.serverCompaction`; wiring always resolves the
    // trigger (`createLLMFromRegistry`), so a flag without one is not sent.
    ...(cfg.serverCompaction === true && typeof cfg.serverCompactionTriggerTokens === 'number'
      ? {
          serverCompaction: {
            triggerTokens: cfg.serverCompactionTriggerTokens,
            ...(triggerCapFor ? { triggerCapFor } : {}),
          },
        }
      : {}),
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('anthropic', anthropicFactory);
}
