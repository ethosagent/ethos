import { resolveToolSecretRef } from '@ethosagent/core';
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSettingsSecretBindingField,
} from '@ethosagent/types';
import { ALL_ENGINES, findEngine, providerSegmentOf, secretGrantsOf } from './engines/roster';
import {
  type AnswerEngine,
  EngineHttpError,
  type EngineId,
  EngineNoKeyError,
  type EngineRequest,
} from './engines/types';
import { renderJson, renderText } from './format';

export { chatgptEngine, DEFAULT_MODEL } from './engines/chatgpt';
export { GEMINI_DEFAULT_MODEL, geminiEngine } from './engines/gemini';
export { GROK_DEFAULT_MODEL, grokEngine } from './engines/grok';
export {
  MICROSOFT_DEFAULT_DEPLOYMENT,
  microsoftEngine,
  resetMicrosoftTokenCacheForTests,
} from './engines/microsoft';
export { PERPLEXITY_DEFAULT_PRESET, perplexityEngine } from './engines/perplexity';
export { ALL_ENGINES, secretGrantsOf } from './engines/roster';
export type {
  AnswerEngine,
  Citation,
  EngineAnswer,
  EngineId,
  EngineRequest,
} from './engines/types';
export { EngineHttpError, EngineNoKeyError } from './engines/types';
export { renderJson, renderText } from './format';

// ---------------------------------------------------------------------------
// engine_ask — put a question to a public AI answer engine and return the
// verbatim answer, the sources it cited, the model that answered, and when.
// One tool over a roster of AnswerEngine adapters (D1): chatgpt, perplexity,
// grok, gemini, microsoft. See plan/phases/tools-answer-engines.md and
// plan/phases/engine-ask-grok-gemini-microsoft.md.
//
// Copied from x_search (extensions/tools-x-search/): same 4-step secret
// resolution, same capability declarations, same error mapping.
// ---------------------------------------------------------------------------

const SEARCH_CONTEXT_SIZES = ['low', 'medium', 'high'] as const;
const FORMATS = ['text', 'json'] as const;
const COUNTRY_RE = /^[A-Z]{2}$/;

const DEFAULT_NUM_CITATIONS = 20;
const MAX_NUM_CITATIONS = 50;

/** Headroom under maxResultChars so the JSON document is never registry-trimmed. */
const MAX_RESULT_CHARS = 30_000;
const JSON_LIMIT = 28_000;

/**
 * A static lead plus every engine's `argNote`, assembled from the roster so an
 * engine that drops an argument cannot forget to say so (plan
 * engine-ask-grok-gemini-microsoft D3). A caller must never take a 4xx for an
 * argument the tool advertises.
 */
const DESCRIPTION = [
  `Ask a public AI answer engine (${ALL_ENGINES.map((e) => e.id).join(', ')}) a question and get its answer with the sources it cited. Use for 'what does the AI-answer layer say about X' questions, not for general web search. Each engine needs its own vendor credential. An argument an engine does not support is accepted and not sent.`,
  ...ALL_ENGINES.map((e) => e.argNote).filter((n): n is string => Boolean(n)),
].join(' ');

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
 * A resolved per-personality engine_ask binding: one secret NAME per engine,
 * keyed by engine id (`chatgpt: openai-brand` → `providers/openai/openai-brand`,
 * `perplexity: pplx-brand` → `providers/perplexity/pplx-brand`) — never a
 * value. `secret` is the permanent legacy alias for `chatgpt` and nothing else
 * (`selectSecretRef` below). An engine with no name here falls to the next
 * rung, and finally to its own `defaultSecretRef`.
 */
export type EngineAskSetting = { secret?: string } & Partial<Record<EngineId, string>>;

export interface CreateEngineAskToolOptions {
  /**
   * per engine, because with two engines a single option cannot say which one
   * it means; it overrides the engine's `modelEnvVar` and its `defaultModel`.
   */
  models?: Partial<Record<EngineId, string>>;
  /**
   * Where each engine's `modelEnvVar` override is read from. The composition
   * root (`packages/wiring/src/compose-tools.ts`) passes the process environment; tool
   * code never reads it itself. Absent → no env override.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Personality-owned binding (source of truth), resolved by personalityId. */
  resolvePersonalitySetting?: (personalityId: string) => EngineAskSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { engine_ask?: EngineAskSetting } | undefined>;
}

export function createEngineAskTool(opts: CreateEngineAskToolOptions = {}): Tool {
  // Resolved once per engine at factory time — factory option, then the
  // engine's own env var (from `opts.env`), then the engine's default.
  const models: Record<string, string> = {};
  for (const e of ALL_ENGINES) {
    models[e.id] = opts.models?.[e.id] ?? opts.env?.[e.modelEnvVar] ?? e.defaultModel;
  }
  const { resolvePersonalitySetting, toolSettings } = opts;

  // Same resolution order as x_search: personality tools.yaml → global
  // toolSettings[pid] → global toolSettings._default → the default-named key.
  // A rung whose name is blank or fails isValidSecretName falls through to the
  // next one — see resolveToolSecretRef (packages/core/src/tool-secret-ref.ts).
  function selectSecretRef(ctx: ToolContext, engine: AnswerEngine): string {
    // A non-bindable engine (microsoft) ignores every binding: its grant is
    // exact refs only (`secretGrantsOf`), so a bound name could only resolve
    // to a ref the tool may not read.
    if (!engine.bindable) return engine.defaultSecretRef;
    const pid = ctx.personalityId;
    const raw: Array<EngineAskSetting | undefined> = [
      pid ? resolvePersonalitySetting?.(pid) : undefined,
      pid ? toolSettings?.[pid]?.engine_ask : undefined,
      toolSettings?._default?.engine_ask,
    ];
    return resolveToolSecretRef({
      // One rung list PER ENGINE (plan engine-ask-per-engine-bindings D5).
      // Within a rung the engine id wins over the legacy `secret` alias, which
      // names the ChatGPT key and nothing else. A rung that binds nothing for
      // THIS engine falls through to the next rung — never sideways to another
      // engine's name, which is what `providers/perplexity/openai-key` was:
      // `resolveToolSecretRef` tests a name's SHAPE, not which vendor it is for.
      rungs: raw.map((r) => ({
        secret: r?.[engine.id] ?? (engine.id === 'chatgpt' ? r?.secret : undefined),
      })),
      prefix: engine.secretPrefix,
      defaultRef: engine.defaultSecretRef,
    });
  }

  return {
    name: 'engine_ask',
    description: DESCRIPTION,
    toolset: 'web',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {
      // Microsoft reaches two hosts, one of them a `*.` wildcard matched by
      // `ScopedFetchImpl.isHostAllowed` (packages/core/src/scoped/scoped-fetch.ts).
      network: { allowedHosts: ALL_ENGINES.flatMap((e) => e.hosts) },
      // The grant is per engine and derived from `bindable` (`secretGrantsOf`):
      // a prefix for a bindable engine, because a personality's name is any
      // `providers/<vendor>/<name>` and must fall inside a static allowlist;
      // the exact refs a non-bindable engine reads (Microsoft's four). Each
      // prefix is labelled per namespace by the settings field that names its
      // `provider` (`deriveProviderRoster`, apps/web-api).
      secrets: ALL_ENGINES.flatMap(secretGrantsOf),
    },
    outputIsUntrusted: true,
    // Per-personality config contract, derived from the roster: one secret
    // picker per BINDABLE engine, keyed by engine id, each scoped by
    // `provider` to that engine's namespace; only the secret NAME is ever
    // stored. No `engine` enum: which engine to ask is a per-CALL argument,
    // and an enum would imply a default engine stored per personality.
    settingsSchema: {
      fields: ALL_ENGINES.filter((e) => e.bindable).map(
        (e): ToolSettingsSecretBindingField => ({
          kind: 'secret-binding',
          key: e.id,
          label: `${e.label} key (${e.id} answer engine)`,
          secretKind: 'answer-engine',
          provider: providerSegmentOf(e),
          providerLabel: e.providerLabel ?? `${e.label} (answer engine)`,
          getKeyUrl: e.getKeyUrl,
        }),
      ),
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
        model: models[engine.id] ?? engine.defaultModel,
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
          return { ok: false, error: engine.noKeyMessage, code: 'not_available' as const };
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
