import type { SecretRef, ToolContext } from '@ethosagent/types';
import { isRecord, MAX_ERROR_BODY_CHARS, orderCitations, type RawCitation } from './citations';
import {
  type AnswerEngine,
  type EngineAnswer,
  EngineHttpError,
  EngineNoKeyError,
  type EngineRequest,
} from './types';
import { domainOf } from './url';

// ---------------------------------------------------------------------------
// gemini — Google's Interactions API
// (`POST https://generativelanguage.googleapis.com/v1beta/interactions`) with
// the `google_search` tool. Shapes as documented on 2026-09-18
// (plan/phases/engine-ask-grok-gemini-microsoft.md §4.2, §5.2): the response
// is `steps[]`, not `output[]` — `thought` | `google_search_call`
// (`arguments.queries[]`) | `google_search_result` | `model_output`
// (`content[]` of `type: 'text'`, with `url_citation` annotations whose
// `title` is a bare domain and whose `start_index` is measured in BYTES).
//
// Nothing optional is sent: `GoogleSearch` has no location and no context-size
// field, and this surface has no `tool_choice` (`supports` below).
//
// Google's Grounding with Google Search terms forbid caching, analysing,
// training on or otherwise learning from grounded results, and name extracting
// them "for another purpose" a violation. The adapter ships for asking and
// reading; it is in no GEO or brand default engine list (plan D14), and
// `argNote` says so to the caller.
// ---------------------------------------------------------------------------

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_API_HOST = 'generativelanguage.googleapis.com';
/** The Interactions API revision the shapes above were read against. */
const GEMINI_API_REVISION = '2026-05-20';
const SECRET_PREFIX = 'providers/gemini/';
const DEFAULT_SECRET_REF = 'providers/gemini/apiKey';

/**
 * Default model (verified 2026-09-18). Overridable per process via
 * `GEMINI_ANSWER_ENGINE_MODEL`, or per instance via
 * `createEngineAskTool({ models: { gemini } })`.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

// `or set GEMINI_API_KEY` is true because `ENV_TO_REF`
// (packages/storage-fs/src/env-secrets.ts) maps it onto `providers/gemini/apiKey`.
const NO_KEY_MESSAGE =
  "No Gemini key configured — add a Google Gemini key in Settings → Keys (Google Gemini) or bind one to engine_ask on the personality's Tools tab, or set GEMINI_API_KEY.";

const encoder = new TextEncoder();

export function parseGeminiResponse(
  body: unknown,
  req: EngineRequest,
  askedAt: string,
): EngineAnswer {
  const root = isRecord(body) ? body : {};
  const steps = Array.isArray(root.steps) ? root.steps : [];

  // `searchCalls` is the google_search_call STEP count — one tool invocation,
  // which is what the field means for every engine in the roster. Gemini 3
  // BILLS per query (`sum(arguments.queries.length)`); that total is the
  // billing quantity, deliberately not substituted for the step count (D10),
  // and EngineAnswer has no slot for it, so it is not computed here.
  let searchCalls = 0;
  const sources: EngineAnswer['sources'] = [];
  const textParts: string[] = [];
  const raw: RawCitation[] = [];
  // BYTE offset of the current text part inside the joined answer. Gemini's
  // start_index is documented in BYTES, so everything here stays in bytes:
  // citations are sorted by byte offsets directly, as integers, and the answer
  // is never sliced by them — comparing them to a UTF-16 index would mis-order
  // any non-ASCII answer (D11; pinned by gemini.test.ts 'byte offsets').
  let byteOffset = 0;

  for (const step of steps) {
    if (!isRecord(step)) continue;
    if (step.type === 'google_search_call') {
      searchCalls += 1;
      continue;
    }
    if (step.type === 'google_search_result') {
      // Documented two ways — with and without `{ title, url, snippet }`
      // entries — so it is read defensively: every entry with a string `url`
      // is a source, and none is ever back-filled from citations (D9).
      if (Array.isArray(step.result)) {
        for (const entry of step.result) {
          if (!isRecord(entry) || typeof entry.url !== 'string') continue;
          const domain = domainOf(entry.url);
          if (domain) sources.push({ url: entry.url, domain });
        }
      }
      continue;
    }
    // `thought` and any future step type are skipped, never fatal.
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const c of step.content) {
      if (!isRecord(c) || c.type !== 'text' || typeof c.text !== 'string') continue;
      if (Array.isArray(c.annotations)) {
        for (const a of c.annotations) {
          if (!isRecord(a) || a.type !== 'url_citation' || typeof a.url !== 'string') continue;
          // `title` is a bare domain (`aljazeera.com`) — dropped, because
          // `domain` already holds it and renderText prints `title` as a
          // headline (D8).
          raw.push({
            url: a.url,
            keys: [
              typeof a.start_index === 'number'
                ? byteOffset + a.start_index
                : Number.POSITIVE_INFINITY,
            ],
          });
        }
      }
      if (c.text.length > 0) {
        textParts.push(c.text);
        byteOffset += encoder.encode(c.text).length + 2; // the '\n\n' join below
      }
    }
  }

  const usage = isRecord(root.usage) ? root.usage : {};
  const inputTokens = usage.total_input_tokens;
  const outputTokens = usage.total_output_tokens;

  return {
    engine: 'gemini',
    model: typeof root.model === 'string' && root.model ? root.model : req.model,
    query: req.query,
    askedAt,
    // No `country`: it is never sent (supports.country false).
    searched: searchCalls > 0,
    searchCalls,
    answerText: textParts.join('\n\n').trim(),
    citations: orderCitations(raw, req.maxCitations),
    sources,
    // `search_suggestions` (an HTML widget) is not stored: EngineAnswer has no
    // slot for vendor HTML, and the display obligation is stated in the docs.
    ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}

export const geminiEngine: AnswerEngine = {
  id: 'gemini',
  label: 'Google',
  hosts: [GEMINI_API_HOST],
  secretPrefix: SECRET_PREFIX,
  defaultSecretRef: DEFAULT_SECRET_REF,
  bindable: true,
  getKeyUrl: 'https://aistudio.google.com/apikey',
  providerLabel: 'Google Gemini (answer engine)',
  supports: { country: false, searchContextSize: false, requireSearch: false },
  argNote:
    "gemini ignores `country`, `search_context_size` and `require_search`. Google's terms forbid storing, analysing or learning from Gemini's search-grounded answers: ask and read them, do not persist or score them.",
  defaultModel: GEMINI_DEFAULT_MODEL,
  modelEnvVar: 'GEMINI_ANSWER_ENGINE_MODEL',
  noKeyMessage: NO_KEY_MESSAGE,

  async ask(req: EngineRequest, ctx: ToolContext, secretRef: SecretRef): Promise<EngineAnswer> {
    const secrets = ctx.secretsResolver;
    const net = ctx.scopedFetch;
    if (!secrets || !net) {
      throw new Error('gemini engine requires ctx.secretsResolver and ctx.scopedFetch');
    }
    const apiKey = await secrets.get(secretRef);
    if (!apiKey) throw new EngineNoKeyError(secretRef);

    const askedAt = new Date().toISOString();
    const response = await net.fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Api-Revision': GEMINI_API_REVISION,
      },
      // NO country, NO search_context_size, NO tool_choice. `store` defaults
      // to true; Google retains prompts and output for 30 days regardless, so
      // `false` is a request, not a guarantee (D12).
      body: JSON.stringify({
        model: req.model,
        input: req.query,
        tools: [{ type: 'google_search' }],
        store: false,
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new EngineHttpError('Google', response.status, text.slice(0, MAX_ERROR_BODY_CHARS));
    }

    return parseGeminiResponse(await response.json(), req, askedAt);
  },
};
