export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  /** Per-slice breakdown of input tokens by request component. */
  requestTokens?: { system: number; tools: number; messages: number };
}

export type CompletionChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_delta'; toolCallId: string; partialJson: string }
  | { type: 'tool_use_end'; toolCallId: string; inputJson: string }
  | {
      type: 'usage';
      usage: TokenUsage;
      metadata?: Record<string, unknown>;
      /**
       * B2 — the provider's own SERVER-ASSIGNED id for this HTTP request
       * (Anthropic's `request-id` response header, surfaced by the SDK as
       * `MessageStream.request_id`). Inbound and opaque to us: it is the value
       * a provider support ticket asks for. Distinct from the loop's
       * client-minted `CompletionOptions.requestId`, which travels outbound.
       * Absent when the provider exposes no such id.
       */
      providerRequestId?: string;
      /**
       * Why `usage.estimatedCostUsd` is what it is — `@ethosagent/pricing`'s
       * `PricingBasis`, duplicated here as a literal union rather than
       * imported (this package has zero deps; pricing depends on types, not
       * the other way around). `undefined` for a provider transport that has
       * not been updated to report it yet.
       */
      costBasis?: 'priced' | 'local' | 'unknown';
    }
  | { type: 'done'; finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' }
  | { type: 'warning'; message: string }
  /**
   * §VI Substantive amendment (openclaw-9.5-adoption item 7, D31) — a
   * provider-side compaction block. The provider summarized the conversation
   * server-side (Anthropic's `compact_20260112` context-management edit) and
   * the block REPLACES everything before it on later requests, so it must be
   * round-tripped: `encryptedContent` is opaque provider metadata carried back
   * byte-for-byte, `content` the readable summary. `content: null` is a failed
   * compaction the provider treats as a no-op. Emitted only by
   * `@ethosagent/llm-anthropic`; every other provider never emits it.
   * Governance: docs/content/building/explanation/llm-provider-governance.md.
   */
  | { type: 'compaction'; content: string | null; encryptedContent: string | null };

export interface Message {
  role: 'user' | 'assistant';
  content: string | MessageContent[];
}

// ---------------------------------------------------------------------------
// Compaction envelope — how a `compaction` chunk lives in history
// ---------------------------------------------------------------------------
//
// Item 7 (D31) — a compaction block must never be forgeable by model output
// (or by anything prompt injection can steer into it). Two forms:
//
// - STORED (sessions.db): an assistant row marked STRUCTURALLY. `toolName` is
//   `COMPACTION_ROW_TOOL_NAME` (a field no model-written assistant row ever
//   carries: `streamStep` sets it only on the compaction path), the payload is
//   in `contentBlocks` (kept out of the FTS index, like image payloads), and
//   `content` is a readable marker (`renderCompactionMarker`) — which is what
//   every transcript, history view and search result shows. Written only by
//   `compactionStoredRow`; read only by `compactionFromStoredRow`.
// - IN MEMORY (`Message` handed to a provider): a string whose prefix carries
//   a random per-process nonce. Built only by `encodeCompactionEnvelope`
//   (from a structural row or a live chunk) and recognised only by
//   `decodeCompactionEnvelope`, which requires that nonce — a model reply that
//   happens to start with the same-looking text is ordinary text. The nonce
//   never reaches a model: providers either turn the envelope into a block
//   (Anthropic) or flatten it to its summary (`flattenCompactionEnvelopes`),
//   and local compaction flattens before summarizing (packages/core
//   `maybeCompact`, `applyOverflowRetry`). Pinned by
//   packages/types/src/__tests__/compaction-envelope.test.ts and
//   packages/core/src/__tests__/server-compaction.test.ts ("forged envelope").

/** The `toolName` that marks a stored assistant row as a compaction block. */
export const COMPACTION_ROW_TOOL_NAME = '_provider_compaction';

/** The readable marker a compaction row shows in transcripts and history. */
export const COMPACTION_MARKER = '— context compacted by the provider —';

/** The two fields of a `compaction` chunk. */
export interface CompactionEnvelope {
  content: string | null;
  encryptedContent: string | null;
}

/** The marker line, followed by the readable summary when there is one. */
export function renderCompactionMarker(summary: string | null): string {
  return summary ? `${COMPACTION_MARKER}\n\n${summary}` : COMPACTION_MARKER;
}

/** The fields of an assistant `StoredMessage` that persist a compaction block. */
export function compactionStoredRow(c: CompactionEnvelope): {
  content: string;
  toolName: string;
  contentBlocks: MessageContent[];
} {
  return {
    content: renderCompactionMarker(c.content),
    toolName: COMPACTION_ROW_TOOL_NAME,
    contentBlocks: [{ type: 'text', text: envelopeJson(c) }],
  };
}

/** The block a stored row persists, or `null` when the row is not one. */
export function compactionFromStoredRow(row: {
  role: string;
  toolName?: string;
  contentBlocks?: MessageContent[];
}): CompactionEnvelope | null {
  if (row.role !== 'assistant' || row.toolName !== COMPACTION_ROW_TOOL_NAME) return null;
  const block = row.contentBlocks?.[0];
  return block?.type === 'text' ? parseEnvelopeJson(block.text) : null;
}

let envelopePrefix: string | undefined;
/** Lazily minted, so importing this module never touches `crypto`. */
function inMemoryPrefix(): string {
  envelopePrefix ??= `\u001eethos:compaction:${globalThis.crypto.randomUUID()}\u001e`;
  return envelopePrefix;
}

/** Encode a compaction block as the in-memory string content of an assistant `Message`. */
export function encodeCompactionEnvelope(c: CompactionEnvelope): string {
  return `${inMemoryPrefix()}${envelopeJson(c)}`;
}

/** The block `text` carries, or `null` unless it is THIS process's envelope. */
export function decodeCompactionEnvelope(text: string): CompactionEnvelope | null {
  const prefix = inMemoryPrefix();
  return text.startsWith(prefix) ? parseEnvelopeJson(text.slice(prefix.length)) : null;
}

function envelopeJson(c: CompactionEnvelope): string {
  return JSON.stringify({ content: c.content, encrypted_content: c.encryptedContent });
}

function parseEnvelopeJson(json: string): CompactionEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { content, encrypted_content } = parsed as Record<string, unknown>;
  const ok = (v: unknown): v is string | null => v === null || typeof v === 'string';
  if (!ok(content) || !ok(encrypted_content)) return null;
  return { content, encryptedContent: encrypted_content };
}

/**
 * D33 — `messages` as a provider that cannot take a compaction block must see
 * them: each envelope becomes its readable summary as assistant text, merged
 * into the assistant message that follows it (so roles still alternate for
 * providers that require it), and `encryptedContent` is dropped. A null or
 * empty summary sends nothing. Returns `messages` itself when there is no
 * envelope. Called by every built-in provider except Anthropic with server
 * compaction on (`toAnthropicMessages`, extensions/llm-anthropic).
 */
export function flattenCompactionEnvelopes(messages: Message[]): Message[] {
  if (!messages.some(isCompactionEnvelopeMessage)) return messages;
  const out: Message[] = [];
  let pending = '';
  for (const msg of messages) {
    if (isCompactionEnvelopeMessage(msg)) {
      const summary = decodeCompactionEnvelope(msg.content as string)?.content ?? '';
      if (summary) pending = pending ? `${pending}\n\n${summary}` : summary;
      continue;
    }
    if (pending && msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content:
          typeof msg.content === 'string'
            ? `${pending}\n\n${msg.content}`
            : [{ type: 'text', text: pending }, ...msg.content],
      });
      pending = '';
      continue;
    }
    if (pending) {
      out.push({ role: 'assistant', content: pending });
      pending = '';
    }
    out.push(msg);
  }
  if (pending) out.push({ role: 'assistant', content: pending });
  return out;
}

function isCompactionEnvelopeMessage(msg: Message): boolean {
  return (
    msg.role === 'assistant' &&
    typeof msg.content === 'string' &&
    decodeCompactionEnvelope(msg.content) !== null
  );
}

/**
 * Item 7 — the `warning` chunk message a provider emits when the API refused
 * its server-side compaction edit and it retried the request without one
 * (`AnthropicProvider.complete`). `streamStep` (packages/core) matches on it to
 * record `llm.server_compaction_rejected` and let local compaction run for the
 * rest of the turn.
 */
export const SERVER_COMPACTION_REJECTED_WARNING =
  'server_compaction_rejected: the API refused the compaction edit; the request was retried without it';

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  // Vision / document blocks. Carried as base64 strings rather than Buffer
  // because @ethosagent/types is zero-dep and the underlying SDKs (Anthropic,
  // OpenAI) ultimately want base64 strings on the wire. The tool that
  // produces these (vision_analyze) encodes once at construction time.
  | {
      type: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      data: string;
      /** Source filename. Carried so block aging can name what it removed
       *  (`[image aged out: shot.png]`) — providers build their payload from
       *  `mediaType`/`data` and never send this. */
      filename?: string;
    }
  | {
      type: 'document';
      mediaType: 'application/pdf';
      data: string;
      /** Source filename — see the `image` variant. */
      filename?: string;
    };

export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  thinkingBudget?: number;
  cacheSystemPrompt?: boolean;
  abortSignal?: AbortSignal;
  stopSequences?: string[];
  modelOverride?: string;
  /**
   * Which provider ENTRY (`providers.<n>.id`, D2/D24 of
   * plan/phases/model-registry.md) `modelOverride` belongs to.
   *
   * `pinned: true` — the call names this one entry and must not fail over to
   * another provider (D21). `pinned: false` — a default-rung call whose model
   * differs from the entry's configured one: only that entry receives the
   * override, and every other hop runs its own model (D23b).
   *
   * Read only by `ChainedProvider` (`packages/core/src/providers/chained-provider.ts`,
   * `optionsFor` and the pinned branch of `complete`), which strips it before
   * calling a hop. A single provider IS its own entry and ignores it; absent →
   * an unscoped override, handled by the same `optionsFor`.
   */
  providerEntry?: { key: string; pinned: boolean };
  /**
   * B2 — the agent loop's per-LLM-call id (minted in `stream-step.ts`), sent
   * OUTBOUND where the provider supports it: openai-compat puts it on the
   * `X-Client-Request-Id` request header so a provider-side log line can be
   * matched to our trace. Client-minted; the provider's own server-assigned id
   * comes back on the `usage` chunk as `providerRequestId`. Providers with no
   * client-id convention ignore this field.
   */
  requestId?: string;
  /**
   * context_compression F2 — message-history cache breakpoints. Each number
   * is an index into `messages`; the provider places a `cache_control` marker
   * on that message so the prompt cache survives compaction. Anthropic allows
   * at most 4 breakpoints total (system + messages) — providers cap to the
   * limit and drop the rest. Providers without prompt caching ignore the field.
   *
   * Lane 2c — on local runtimes the equivalent of a cache breakpoint is
   * BYTE-STABILITY of the request prefix, not a marker: vLLM
   * (`--enable-prefix-caching`) and llama.cpp (`--cache-reuse`) hash prefixes,
   * so there is nothing to annotate. Do NOT build an openai-compat consumer
   * for this field — keeping the serialized request byte-stable across turns
   * is what makes their caches hit.
   */
  cacheBreakpoints?: number[];
  /** Namespaced escape hatch for provider-specific options. Keys are provider
   *  names (e.g. `anthropic`, `openai`), values are provider-specific option
   *  bags. Example: `{ anthropic: { thinkingBudget: 10000 } }`. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * §3 — build the `providerOptions` bag that requests grammar-constrained JSON
 * output for a given JSON Schema, so callers don't hand-assemble the nested
 * shape. Merge the result into `CompletionOptions.providerOptions`. The
 * openai-compat transport reads `providerOptions['openai-compat'].responseFormat`
 * and maps it to the provider dialect (`response_format` json_schema / Ollama
 * `format` / vLLM `guided_json`). Only consume this when the provider declares
 * `capabilities.structuredOutput` — models without it ignore the field.
 */
export function structuredOutputOption(
  schema: Record<string, unknown>,
  opts?: { name?: string; strict?: boolean },
): Record<string, Record<string, unknown>> {
  return {
    'openai-compat': {
      responseFormat: {
        name: opts?.name ?? 'response',
        strict: opts?.strict ?? true,
        schema,
      },
    },
  };
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  parallelToolCalls?: boolean;
  visionImages?: boolean;
  visionDocuments?: boolean;
  audioIn?: boolean;
  structuredOutput?: boolean;
  thinking?: boolean;
  promptCaching?: boolean;
  cacheBreakpoints?: boolean;
  systemPromptStyle?: 'top-level' | 'system-role' | 'developer-role' | 'fold-into-first-user';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  stopSequences?: boolean;
  logprobs?: boolean;
  tokenCounting?: 'real' | 'estimated' | false;
  contractVersion?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching: boolean;
  readonly supportsThinking: boolean;
  supportsVision?: {
    images: boolean;
    documents: boolean;
  };
  supportsCacheBreakpoints?: boolean;
  supportsTokenCounting?: 'real' | 'estimated';
  capabilities?: ProviderCapabilities;
  complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk>;
  countTokens(messages: Message[]): Promise<number>;
}

export interface ToolDefinitionLite {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Lane 2a — how a provider orders tool definitions when serializing the
 * request body. `'stable'` (the default) applies the deterministic ASCII
 * ordering below; `'insertion'` preserves registration order (the pre-Lane-2
 * behavior). The escape hatch exists as a temporary rollback lever; removal
 * is tracked in `plan/uncompleted-tasks.md` (eng review D6/D13).
 */
export type ToolOrder = 'insertion' | 'stable';

/**
 * Lane 2a — deterministic ASCII-stable ordering for tool definitions at the
 * provider serialization boundary. Tool definitions ship AHEAD of messages in
 * the request body, so they are part of the cacheable prefix; registration
 * order is not stable across restarts (MCP, plugin, delegation, and goal
 * tools register after loop construction, and MCP server connection order
 * depends on network timing). Sorting by name (raw code-unit comparison — no
 * locale, no collation tables) makes the prefix byte-identical across
 * restarts.
 *
 * The ordering is a CACHING DEVICE, not a priority signal — it carries no
 * semantic meaning and models must not be expected to prefer earlier tools.
 *
 * Applied at the provider boundary, NOT in `ToolRegistry.toDefinitions()`:
 * callers of `toDefinitions` (bench, static estimates) must keep measuring
 * the same set the provider sends, and one sort site per provider keeps one
 * source of truth for what goes on the wire.
 */
export function orderToolDefinitions(
  tools: ToolDefinitionLite[],
  order: ToolOrder = 'stable',
): ToolDefinitionLite[] {
  if (order === 'insertion') return tools;
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface AuthProfile {
  id: string;
  apiKey: string;
  baseUrl?: string;
  priority: number;
}

export type FailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'timeout'
  | 'network'
  | 'model_not_found'
  | 'content_filter'
  | 'unknown';

// ---------------------------------------------------------------------------
// LLM Provider Registry — pluggable provider factories
// ---------------------------------------------------------------------------

export interface LLMProviderFactoryContext {
  config: Record<string, unknown>;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}

export type LLMProviderFactory = (
  ctx: LLMProviderFactoryContext,
) => LLMProvider | Promise<LLMProvider>;

export interface LLMProviderRegistry {
  register(name: string, factory: LLMProviderFactory): void;
  unregister(name: string): void;
  get(name: string): LLMProviderFactory | undefined;
  list(): string[];
}

// ---------------------------------------------------------------------------
// Config-only provider manifest — Tier 1 (zero-code) authoring
// ---------------------------------------------------------------------------

export interface ConfigOnlyProviderManifest {
  id: string;
  name: string;
  transport: 'openai-chat-completions';
  baseUrl: string;
  auth: {
    location: 'header' | 'query';
    name: string;
    scheme?: 'bearer' | 'raw';
    secretRef: string;
  };
  capabilities: ProviderCapabilities;
  defaultModel?: string;
  models?: string[];
}

// ---------------------------------------------------------------------------
// Auth descriptors — pluggable authentication for LLM providers
// ---------------------------------------------------------------------------

export type AuthLocation = 'header' | 'query';

export interface StaticAuthDescriptor {
  type: 'static';
  location: AuthLocation;
  name: string;
  scheme?: 'bearer' | 'raw';
}

export interface SignerAuthDescriptor {
  type: 'signer';
  signerId: string;
}

export interface GcpOAuthDescriptor {
  type: 'gcp-oauth';
  projectId: string;
  region: string;
}

export type AuthDescriptor = StaticAuthDescriptor | SignerAuthDescriptor | GcpOAuthDescriptor;

export interface AuthSigner {
  sign(request: AuthSignRequest): Promise<AuthSignResult>;
}

export interface AuthSignRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface AuthSignResult {
  headers: Record<string, string>;
  url?: string;
}
