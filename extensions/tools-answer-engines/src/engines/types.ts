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
  engine: 'chatgpt';
  /** As the API reported it, not as requested. */
  model: string;
  query: string;
  /** ISO-8601, taken before the request was sent. */
  askedAt: string;
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

export interface AnswerEngine {
  readonly id: EngineAnswer['engine'];
  /** For capabilities.network.allowedHosts. */
  readonly host: string;
  /** 'providers/openai/' — a personality binding resolves `${secretPrefix}${name}`. */
  readonly secretPrefix: string;
  readonly defaultSecretRef: SecretRef;
  /**
   * Resolves `secretRef` through `ctx.secretsResolver`, then asks. Throws
   * `EngineNoKeyError` when the ref resolves to nothing (before any network
   * call), `EngineHttpError` on a non-2xx response, and a plain Error on
   * transport failure; the tool maps each throw to a ToolResult.
   */
  ask(req: EngineRequest, ctx: ToolContext, secretRef: SecretRef): Promise<EngineAnswer>;
}

/** A non-2xx response. `status` lets the tool map 401 to `not_available`. */
export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`OpenAI API error ${status}: ${body}`);
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
