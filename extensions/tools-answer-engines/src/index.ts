import { resolveToolSecretRef } from '@ethosagent/core';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { DEFAULT_MODEL } from './engines/chatgpt';
import { ALL_ENGINES, findEngine } from './engines/roster';
import {
  type AnswerEngine,
  EngineHttpError,
  EngineNoKeyError,
  type EngineRequest,
} from './engines/types';
import { renderJson, renderText } from './format';

export { chatgptEngine, DEFAULT_MODEL } from './engines/chatgpt';
export { ALL_ENGINES } from './engines/roster';
export type { AnswerEngine, Citation, EngineAnswer, EngineRequest } from './engines/types';
export { EngineHttpError, EngineNoKeyError } from './engines/types';
export { renderJson, renderText } from './format';

// ---------------------------------------------------------------------------
// engine_ask — put a question to a public AI answer engine and return the
// verbatim answer, the sources it cited, the model that answered, and when.
// One tool over a roster of AnswerEngine adapters (D1); ChatGPT is the only
// entry in v1. See plan/phases/tools-answer-engines.md.
//
// Copied from x_search (extensions/tools-x-search/): same 4-step secret
// resolution, same capability declarations, same error mapping.
// ---------------------------------------------------------------------------

// The `or set OPENAI_API_KEY` clause is true because `ENV_TO_REF` in
// `packages/storage-fs/src/env-secrets.ts` maps that env var onto
// `providers/openai/apiKey` — the default ref below. It does NOT cover a
// personality-bound name, which only the vault holds.
const NO_KEY_MESSAGE =
  "No OpenAI key configured — add an OpenAI key in Settings → Security → Named Secrets (provider OpenAI), then bind it to engine_ask in the personality's tool settings, or set OPENAI_API_KEY.";

const SEARCH_CONTEXT_SIZES = ['low', 'medium', 'high'] as const;
const FORMATS = ['text', 'json'] as const;
const COUNTRY_RE = /^[A-Z]{2}$/;

const DEFAULT_NUM_CITATIONS = 20;
const MAX_NUM_CITATIONS = 50;

/** Headroom under maxResultChars so the JSON document is never registry-trimmed. */
const MAX_RESULT_CHARS = 30_000;
const JSON_LIMIT = 28_000;

export interface EngineAskArgs {
  query: string;
  engine?: string;
  country?: string;
  search_context_size?: (typeof SEARCH_CONTEXT_SIZES)[number];
  require_search?: boolean;
  num_citations?: number;
  format?: (typeof FORMATS)[number];
}

/**
 * A resolved per-personality engine_ask binding. `secret` is a NAME only
 * (e.g. `openai-brand`) — never a value — that resolves to
 * `providers/openai/<name>` in the vault. Absent → `providers/openai/apiKey`.
 */
export interface EngineAskSetting {
  secret?: string;
}

export interface CreateEngineAskToolOptions {
  /** Overrides DEFAULT_MODEL / OPENAI_ANSWER_ENGINE_MODEL. See DEFAULT_MODEL's comment. */
  model?: string;
  /** Personality-owned binding (source of truth), resolved by personalityId. */
  resolvePersonalitySetting?: (personalityId: string) => EngineAskSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { engine_ask?: EngineAskSetting } | undefined>;
}

export function createEngineAskTool(opts: CreateEngineAskToolOptions = {}): Tool {
  const model = opts.model ?? process.env.OPENAI_ANSWER_ENGINE_MODEL ?? DEFAULT_MODEL;
  const { resolvePersonalitySetting, toolSettings } = opts;

  // Same resolution order as x_search: personality tools.yaml → global
  // toolSettings[pid] → global toolSettings._default → the default-named key.
  // A rung whose name is blank or fails isValidSecretName falls through to the
  // next one — see resolveToolSecretRef (packages/core/src/tool-secret-ref.ts).
  function selectSecretRef(ctx: ToolContext, engine: AnswerEngine): string {
    const pid = ctx.personalityId;
    return resolveToolSecretRef({
      rungs: [
        pid ? resolvePersonalitySetting?.(pid) : undefined,
        pid ? toolSettings?.[pid]?.engine_ask : undefined,
        toolSettings?._default?.engine_ask,
      ],
      prefix: engine.secretPrefix,
      defaultRef: engine.defaultSecretRef,
    });
  }

  return {
    name: 'engine_ask',
    description:
      "Ask a public AI answer engine (ChatGPT) a question and get its answer with the sources it cited. Use for 'what does the AI-answer layer say about X' questions, not for general web search. Requires an OpenAI API key.",
    toolset: 'web',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {
      network: { allowedHosts: ALL_ENGINES.map((e) => e.host) },
      // Prefix grant per engine namespace: any personality binding is
      // `providers/openai/<name>`, so it always falls inside this static allowlist.
      secrets: ALL_ENGINES.map((e) => `${e.secretPrefix}*`),
    },
    outputIsUntrusted: true,
    // Per-personality config contract. The settings UI renders a secret picker
    // over `answer-engine` named secrets; only the secret NAME is ever stored.
    // No `engine` enum until the roster has two entries (§6).
    settingsSchema: {
      fields: [
        {
          kind: 'secret-binding',
          key: 'secret',
          label: 'OpenAI API key (answer engine)',
          secretKind: 'answer-engine',
          providerLabel: 'OpenAI (ChatGPT answer engine)',
          getKeyUrl: 'https://platform.openai.com/api-keys',
        },
      ],
    },
    // Always registered, same reasoning as web_search
    // (extensions/tools-web/src/index.ts) and x_search: a key can arrive from
    // the named-secrets vault, which isAvailable() cannot see (no ToolContext
    // at filter time). execute() surfaces a clear "no key configured" error.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question to put to the engine, verbatim' },
        engine: {
          type: 'string',
          enum: ALL_ENGINES.map((e) => e.id),
          description: 'Which answer engine to ask (default chatgpt)',
        },
        country: {
          type: 'string',
          description:
            "ISO 3166-1 alpha-2 country the asker is in (e.g. IN). Unset → the engine's default.",
        },
        search_context_size: {
          type: 'string',
          enum: [...SEARCH_CONTEXT_SIZES],
          description: 'How much web context the engine may pull in (default medium)',
        },
        require_search: {
          type: 'boolean',
          description:
            'Force the engine to search before answering (default false — it may answer from memory, and the result says whether it searched)',
        },
        num_citations: {
          type: 'number',
          description: `Maximum inline citations to return (default ${DEFAULT_NUM_CITATIONS}, max ${MAX_NUM_CITATIONS})`,
        },
        format: {
          type: 'string',
          enum: [...FORMATS],
          description:
            'text (default): answer, numbered sources, footer. json: the full record as one JSON document.',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const {
        query,
        engine: engineId,
        country,
        search_context_size,
        require_search,
        num_citations,
        format,
      } = args as EngineAskArgs;

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      const engine = findEngine(engineId ?? 'chatgpt');
      if (!engine) {
        return {
          ok: false,
          error: `Unknown engine "${engineId}" — one of: ${ALL_ENGINES.map((e) => e.id).join(', ')}`,
          code: 'input_invalid',
        };
      }
      if (country !== undefined && !COUNTRY_RE.test(country)) {
        return {
          ok: false,
          error: 'country must be an ISO 3166-1 alpha-2 code (two upper-case letters, e.g. IN)',
          code: 'input_invalid',
        };
      }
      const searchContextSize = search_context_size ?? 'medium';
      if (!SEARCH_CONTEXT_SIZES.includes(searchContextSize)) {
        return {
          ok: false,
          error: `search_context_size must be one of: ${SEARCH_CONTEXT_SIZES.join(', ')}`,
          code: 'input_invalid',
        };
      }
      const outputFormat = format ?? 'text';
      if (!FORMATS.includes(outputFormat)) {
        return {
          ok: false,
          error: `format must be one of: ${FORMATS.join(', ')}`,
          code: 'input_invalid',
        };
      }

      if (!ctx.secretsResolver || !ctx.scopedFetch) {
        return {
          ok: false,
          error: 'Capability backends not configured',
          code: 'not_available' as const,
        };
      }

      const request: EngineRequest = {
        query,
        model,
        ...(country ? { country } : {}),
        searchContextSize,
        requireSearch: require_search ?? false,
        maxCitations: Math.min(num_citations ?? DEFAULT_NUM_CITATIONS, MAX_NUM_CITATIONS),
      };

      try {
        const answer = await engine.ask(request, ctx, selectSecretRef(ctx, engine));
        if (outputFormat === 'json') {
          const rendered = renderJson(answer, JSON_LIMIT);
          return { ok: true, value: rendered.value, structured: { ...rendered.answer } };
        }
        return { ok: true, value: renderText(answer), structured: { ...answer } };
      } catch (err) {
        // A 401 means exactly what an empty ref means: no usable key.
        if (
          err instanceof EngineNoKeyError ||
          (err instanceof EngineHttpError && err.status === 401)
        ) {
          return { ok: false, error: NO_KEY_MESSAGE, code: 'not_available' as const };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

export const engineAskTool = createEngineAskTool();
