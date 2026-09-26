import type { SecretRef, ToolContext } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// The engine contract — plan/phases/tools-answer-engines.md §5. An engine
// builds one request, POSTs it through `ctx.scopedFetch`, and maps the
// response. It does not retry, sample, detect brand mentions or interpret
// the answer (D2); those belong to the caller.
// ---------------------------------------------------------------------------

export interface EngineRequest {
  query: string;
  /** Resolved by the tool (factory option → env → the engine's default). */
  model: string;
  /** ISO 3166-1 alpha-2. Absent → the engine's own default. */
  country?: string;
  searchContextSize: 'low' | 'medium' | 'high';
  /** true → tool_choice 'required'; false → 'auto'. */
  requireSearch: boolean;
  maxCitations: number;
}

export interface Citation {
  url: string;
  title?: string;
  /** Registrable host, lower-cased, `www.` stripped. */
  domain: string;
  /** 1-based order of first appearance in the answer text. */
  position: number;
}

export interface EngineAnswer {
  /** Union grows with the roster. */
  engine: 'chatgpt' | 'perplexity' | 'grok' | 'gemini' | 'microsoft';
  /** As the API reported it, not as requested. */
  model: string;
  query: string;
  /** ISO-8601, taken before the request was sent. */
  askedAt: string;
  /**
   * The country the engine was asked from — set only when the engine SENT it
   * (`supports.country`). An engine that does not take a location leaves it
   * absent rather than claim a location it never applied.
   */
  country?: string;
  /** Did the engine actually run a search. Reported, never assumed. */
  searched: boolean;
  searchCalls: number;
  /** Verbatim. */
  answerText: string;
  /** Cited inline in the answer (url_citation annotations). */
  citations: Citation[];
  /** Consulted but not necessarily cited (web_search_call.action.sources). */
  sources: Array<{ url: string; domain: string }>;
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Set by `renderJson` (src/format.ts) when the document was reduced to fit
   * the result budget — citations and/or sources dropped, answer text or the
   * echoed query shortened. Absent means the record is complete as returned.
   */
  truncated?: boolean;
}

/** The id of an engine in the roster. */
export type EngineId = EngineAnswer['engine'];

export interface AnswerEngine {
  readonly id: EngineId;
  /**
   * The vendor name used in error text ('OpenAI' / 'Perplexity'), so a failure
   * names the engine that actually failed.
   */
  readonly label: string;
  /**
   * Every host this engine reaches, for capabilities.network.allowedHosts.
   * Microsoft reaches two (the Entra token host and its Foundry project).
   */
  readonly hosts: readonly string[];
  /** 'providers/openai/' — a personality binding resolves `${secretPrefix}${name}`. */
  readonly secretPrefix: string;
  readonly defaultSecretRef: SecretRef;
  /**
   * Whether a personality may bind its own key for this engine. `true` → the
   * engine's `capabilities.secrets` grant is the prefix `${secretPrefix}*` and
   * the tool's `settingsSchema` carries one picker for it (keyed by `id`);
   * `false` → the grant is the exact `operatorSecretRefs` (or
   * `defaultSecretRef`), there is no picker, and every binding is ignored.
   * All three follow from this one flag (`secretGrantsOf` in `./roster`,
   * `selectSecretRef` and
   * `settingsSchema` in `../index`), so the grant and the settings field cannot
   * disagree (plan engine-ask-per-engine-bindings D8).
   */
  readonly bindable: boolean;
  /**
   * A NON-bindable engine's exact refs, when it reads more than
   * `defaultSecretRef` (Microsoft reads four). Absent → `[defaultSecretRef]`.
   * Ignored for a bindable engine, whose grant is its whole namespace.
   */
  readonly operatorSecretRefs?: readonly SecretRef[];
  /**
   * Which optional arguments this engine actually SENDS. An argument an
   * engine does not support is accepted by the tool and never sent — xAI
   * rejects a request carrying `search_context_size` or `user_location`, so a
   * pass-through would be a 400, not a no-op. Each adapter reads only the
   * request fields its `supports` declares; the roster-wide test in
   * `__tests__/engine-ask.test.ts` ('sends no argument an engine does not
   * support') pins that the two agree.
   */
  readonly supports: {
    readonly country: boolean;
    readonly searchContextSize: boolean;
    readonly requireSearch: boolean;
  };
  /**
   * One sentence for the tool description. Required in practice when
   * `supports` has any `false` (pinned in `__tests__/engine-ask.test.ts`);
   * also carries a vendor's terms on what a caller may do with the answer.
   */
  readonly argNote?: string;
  /** Where an operator obtains this engine's key — the picker's Get-a-key link. */
  readonly getKeyUrl: string;
  /**
   * The Named Secrets label for this engine's `providers/<segment>/`
   * namespace. Absent → `${label} (answer engine)`.
   */
  readonly providerLabel?: string;
  /** The model (chatgpt) or preset (perplexity) used when nothing overrides it. */
  readonly defaultModel: string;
  /** The env var that overrides it. */
  readonly modelEnvVar: string;
  /** The `not_available` text used when the ref resolves empty or the API returns 401. */
  readonly noKeyMessage: string;
  /**
   * Resolves `secretRef` through `ctx.secretsResolver`, then asks. Throws
   * `EngineNoKeyError` when the ref resolves to nothing (before any network
   * call), `EngineHttpError` on a non-2xx response, and a plain Error on
   * transport failure; the tool maps each throw to a ToolResult.
   */
  ask(req: EngineRequest, ctx: ToolContext, secretRef: SecretRef): Promise<EngineAnswer>;
}

/**
 * A non-2xx response. `status` lets the tool map 401 to `not_available`;
 * `label` is the engine's vendor name so the message names the engine that
 * actually failed.
 */
export class EngineHttpError extends Error {
  constructor(
    label: string,
    readonly status: number,
    body: string,
  ) {
    super(`${label} API error ${status}: ${body}`);
    this.name = 'EngineHttpError';
  }
}

/** The bound secret ref resolved to an empty value. No request was sent. */
export class EngineNoKeyError extends Error {
  constructor(readonly secretRef: SecretRef) {
    super(`No API key at ${secretRef}`);
    this.name = 'EngineNoKeyError';
  }
}
