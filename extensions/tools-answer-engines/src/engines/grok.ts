import type { SecretRef, ToolContext } from '@ethosagent/types';
import {
  isRecord,
  MAX_ERROR_BODY_CHARS,
  orderCitations,
  type RawCitation,
  urlsOf,
} from './citations';
import {
  type AnswerEngine,
  type EngineAnswer,
  EngineHttpError,
  EngineNoKeyError,
  type EngineRequest,
} from './types';
import { domainOf } from './url';

// ---------------------------------------------------------------------------
// grok — xAI's Responses API (`POST https://api.x.ai/v1/responses`) with the
// `web_search` tool. Shapes as documented on 2026-09-18
// (plan/phases/engine-ask-grok-gemini-microsoft.md §4.1, §5.1): output items
// `web_search_call` (whose `action` is `search` with `sources[].url`, or
// `open_page` / `find_in_page` with `url`) and `message`, whose
// `content[].output_text.annotations[]` are `url_citation`s whose `title` is
// the citation NUMBER as a string, not a page title.
//
// Three request fields must NOT be sent — `search_context_size`,
// `user_location` and `external_web_access` exist "for OpenAI API
// compatibility ONLY. Request will be rejected if this field is set." So this
// adapter never reads `req.country` or `req.searchContextSize` (`supports`
// below; pinned by grok.test.ts 'never sends ...').
//
// The question is the ENTIRE input — no `instructions`, no system prompt
// (parent plan D3).
// ---------------------------------------------------------------------------

const XAI_API_URL = 'https://api.x.ai/v1/responses';
const XAI_API_HOST = 'api.x.ai';
const SECRET_PREFIX = 'providers/xai/';
const DEFAULT_SECRET_REF = 'providers/xai/apiKey';

/**
 * Default model — `grok-4.6`, the model xAI's own web-search examples use
 * (verified 2026-09-18; the same default `x_search` carries). Overridable per
 * process via `XAI_ANSWER_ENGINE_MODEL`, or per instance via
 * `createEngineAskTool({ models: { grok } })`.
 */
export const GROK_DEFAULT_MODEL = 'grok-4.6';

// `or set XAI_API_KEY` is true because `ENV_TO_REF`
// (packages/storage-fs/src/env-secrets.ts) maps it onto `providers/xai/apiKey`.
// The 400 clause exists because xAI has no 401: an invalid key and an invalid
// request are both HTTP 400 (plan D7), so a rejected key surfaces as an
// execution error quoting xAI, never as this message.
const NO_KEY_MESSAGE =
  "No xAI key configured — add an xAI key in Settings → Keys (xAI) or bind one to engine_ask on the personality's Tools tab, or set XAI_API_KEY. xAI reports an invalid key as HTTP 400, so a rejected key shows as an xAI API error instead of this message.";

/** A positive integer citation number from xAI's `title`, else undefined. */
function citationNumber(title: unknown): number | undefined {
  if (typeof title !== 'string' || !/^\d+$/.test(title.trim())) return undefined;
  const n = Number.parseInt(title, 10);
  return n > 0 ? n : undefined;
}

export function parseGrokResponse(
  body: unknown,
  req: EngineRequest,
  askedAt: string,
): EngineAnswer {
  const root = isRecord(body) ? body : {};
  const output = Array.isArray(root.output) ? root.output : [];

  let callItems = 0;
  const sources: EngineAnswer['sources'] = [];
  const textParts: string[] = [];
  const raw: RawCitation[] = [];
  // Offset of the current output_text part inside the joined answer, so a
  // part-relative start_index orders citations across parts (as chatgpt.ts).
  let offset = 0;

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === 'web_search_call') {
      callItems += 1;
      const action = isRecord(item.action) ? item.action : {};
      // `search` carries `sources[].url`; `open_page` / `find_in_page` carry
      // `url`. `action.query` is not recorded — EngineAnswer has no slot for
      // the engine's own queries (plan §5.1).
      const urls = urlsOf(action.sources);
      if (typeof action.url === 'string') urls.push(action.url);
      for (const url of urls) {
        const domain = domainOf(url);
        if (domain) sources.push({ url, domain });
      }
      continue;
    }
    // Unknown item types (reasoning, etc.) are skipped, never fatal.
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (!isRecord(c) || c.type !== 'output_text' || typeof c.text !== 'string') continue;
      if (Array.isArray(c.annotations)) {
        for (const a of c.annotations) {
          if (!isRecord(a) || a.type !== 'url_citation' || typeof a.url !== 'string') continue;
          // Ordering: start_index, else the citation number xAI put in
          // `title`, else annotation array order (the stable sort). Never the
          // number alone when an offset exists — the offset is the answer's
          // own order, the number only xAI's rendering of it. `title` is
          // NEVER a page title here, so `citations[].title` stays unset (D8).
          const start =
            typeof a.start_index === 'number' ? offset + a.start_index : Number.POSITIVE_INFINITY;
          raw.push({
            url: a.url,
            keys: [start, citationNumber(a.title) ?? Number.POSITIVE_INFINITY],
          });
        }
      }
      if (c.text.length > 0) {
        textParts.push(c.text);
        offset += c.text.length + 2; // the '\n\n' join below
      }
    }
  }

  const usage = isRecord(root.usage) ? root.usage : {};
  const details = isRecord(usage.server_side_tool_usage_details)
    ? usage.server_side_tool_usage_details
    : {};
  // The response's own count is preferred; the item count is the fallback —
  // the same preference perplexity.ts has for `search_web.invocation`.
  const searchCalls =
    typeof details.web_search_calls === 'number' ? details.web_search_calls : callItems;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;

  return {
    engine: 'grok',
    model: typeof root.model === 'string' && root.model ? root.model : req.model,
    query: req.query,
    askedAt,
    // No `country`: it is never sent (supports.country false).
    searched: searchCalls > 0,
    searchCalls,
    answerText: textParts.join('\n\n').trim(),
    citations: orderCitations(raw, req.maxCitations),
    sources,
    ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}

export const grokEngine: AnswerEngine = {
  id: 'grok',
  label: 'xAI',
  hosts: [XAI_API_HOST],
  secretPrefix: SECRET_PREFIX,
  defaultSecretRef: DEFAULT_SECRET_REF,
  // Bindable: the grant is `providers/xai/*`, the namespace `x_search` already
  // grants (plan engine-ask-per-engine-bindings §11).
  bindable: true,
  getKeyUrl: 'https://console.x.ai/',
  providerLabel: 'xAI (Grok answer engine)',
  supports: { country: false, searchContextSize: false, requireSearch: true },
  argNote:
    'grok ignores `country` and `search_context_size` — xAI rejects a request carrying either, so they are never sent.',
  defaultModel: GROK_DEFAULT_MODEL,
  modelEnvVar: 'XAI_ANSWER_ENGINE_MODEL',
  noKeyMessage: NO_KEY_MESSAGE,

  async ask(req: EngineRequest, ctx: ToolContext, secretRef: SecretRef): Promise<EngineAnswer> {
    const secrets = ctx.secretsResolver;
    const net = ctx.scopedFetch;
    if (!secrets || !net) {
      throw new Error('grok engine requires ctx.secretsResolver and ctx.scopedFetch');
    }
    const apiKey = await secrets.get(secretRef);
    if (!apiKey) throw new EngineNoKeyError(secretRef);

    const askedAt = new Date().toISOString();
    const response = await net.fetch(XAI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // NO search_context_size, NO user_location, NO external_web_access (each
      // fails the call), NO allowed_domains / excluded_domains (a filtered
      // answer is a different answer). `store` defaults to true, so false is
      // sent explicitly (plan D12).
      body: JSON.stringify({
        model: req.model,
        input: [{ role: 'user', content: req.query }],
        tools: [{ type: 'web_search' }],
        tool_choice: req.requireSearch ? 'required' : 'auto',
        store: false,
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      // A 400 stays an EngineHttpError (→ execution_failed) carrying xAI's own
      // body: xAI has no 401 and uses 400 for a bad key AND a bad request, so
      // mapping it to not_available would mislabel every malformed request.
      const text = await response.text().catch(() => '');
      throw new EngineHttpError('xAI', response.status, text.slice(0, MAX_ERROR_BODY_CHARS));
    }

    return parseGrokResponse(await response.json(), req, askedAt);
  },
};
