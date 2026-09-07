import type { SecretRef, ToolContext } from '@ethosagent/types';
import {
  type AnswerEngine,
  type Citation,
  type EngineAnswer,
  EngineHttpError,
  EngineNoKeyError,
  type EngineRequest,
} from './types';

// ---------------------------------------------------------------------------
// chatgpt — OpenAI's Responses API (`POST https://api.openai.com/v1/responses`)
// with the `web_search` tool type. Request and response shapes were verified
// against developers.openai.com/api/docs/guides/tools-web-search on
// 2026-09-07 (plan/phases/tools-answer-engines.md §3): output items are
// `web_search_call` (with `action.sources` when
// `include: ['web_search_call.action.sources']` is requested) and `message`,
// whose `content[].annotations[]` carry `type: 'url_citation'` with `url`,
// `title`, `start_index`, `end_index`.
//
// The question is the ENTIRE input — no `instructions`, no system prompt, no
// format request (D3). Anything added here is a thumb on the scale a
// measurement caller would then have to explain.
// ---------------------------------------------------------------------------

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_API_HOST = 'api.openai.com';
const SECRET_PREFIX = 'providers/openai/';
const DEFAULT_SECRET_REF = 'providers/openai/apiKey';

/** Non-2xx bodies are cut to this many characters before they reach an error. */
const MAX_ERROR_BODY_CHARS = 500;

/**
 * Default model. Confirmed against developers.openai.com/api/docs/guides/tools-web-search
 * on 2026-09-07: "gpt-5.5" is named for Responses web search there. Overridable
 * per-process via the `OPENAI_ANSWER_ENGINE_MODEL` env var, or per-instance via
 * `createEngineAskTool({ model })` — never hardcoded with no escape hatch, since
 * OpenAI's recommended model will move on before this file does (D7).
 */
export const DEFAULT_MODEL = 'gpt-5.5';

interface ResponsesAnnotation {
  type?: string;
  url?: unknown;
  title?: unknown;
  start_index?: unknown;
}

interface ResponsesContent {
  type?: string;
  text?: unknown;
  annotations?: unknown;
}

interface ResponsesOutputItem {
  type?: string;
  content?: unknown;
  action?: { sources?: unknown } | null;
}

interface ResponsesApiBody {
  model?: unknown;
  output?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown } | null;
}

/** Hostname lower-cased with a leading `www.` stripped; null when `url` does not parse. */
function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * `action.sources` is documented as `{ url }` objects; plain URL strings are
 * accepted too, the same defensive posture as x_search's normalizeCitations.
 */
function urlsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object' && 'url' in item) {
      const url = (item as { url?: unknown }).url;
      if (typeof url === 'string') out.push(url);
    }
  }
  return out;
}

function parseResponse(body: ResponsesApiBody, req: EngineRequest, askedAt: string): EngineAnswer {
  const output = Array.isArray(body.output) ? (body.output as ResponsesOutputItem[]) : [];

  let searchCalls = 0;
  const sources: EngineAnswer['sources'] = [];
  const textParts: string[] = [];
  const raw: Array<{ url: string; title?: string; order: number }> = [];
  // Offset of the current output_text part inside the joined answer, so
  // start_index (relative to its own part) orders citations across parts.
  let offset = 0;

  for (const item of output) {
    if (item?.type === 'web_search_call') {
      searchCalls += 1;
      for (const url of urlsOf(item.action?.sources)) {
        const domain = domainOf(url);
        if (domain) sources.push({ url, domain });
      }
      continue;
    }
    // Unknown item types (reasoning, etc.) are skipped, never fatal.
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content as ResponsesContent[]) {
      if (c?.type !== 'output_text' || typeof c.text !== 'string') continue;
      if (Array.isArray(c.annotations)) {
        for (const a of c.annotations as ResponsesAnnotation[]) {
          if (a?.type !== 'url_citation' || typeof a.url !== 'string') continue;
          const start =
            typeof a.start_index === 'number' ? a.start_index : Number.POSITIVE_INFINITY;
          raw.push({
            url: a.url,
            ...(typeof a.title === 'string' ? { title: a.title } : {}),
            order: offset + start,
          });
        }
      }
      if (c.text.length > 0) {
        textParts.push(c.text);
        offset += c.text.length + 2; // the '\n\n' join below
      }
    }
  }

  // Ordered by where the citation sits in the answer (first occurrence wins),
  // then de-duplicated. URL IDENTITY IS EXACT STRING EQUALITY — no trailing
  // slash, fragment, case or query-string normalisation. Deliberately
  // conservative: `?page=2`, `#section-3` and a trailing slash can all name a
  // different resource, and two citations that MIGHT be different documents
  // must stay two citations. The cost is the reverse — the same document cited
  // under two spellings survives as two entries — which is the safe direction
  // for a tool whose output is evidence. `domain` is normalised (lower-cased,
  // `www.` stripped) for grouping only; it is never the identity key.
  raw.sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const c of raw) {
    if (citations.length >= req.maxCitations) break;
    if (seen.has(c.url)) continue;
    const domain = domainOf(c.url);
    if (!domain) continue;
    seen.add(c.url);
    citations.push({
      url: c.url,
      ...(c.title !== undefined ? { title: c.title } : {}),
      domain,
      position: citations.length + 1,
    });
  }

  const inputTokens = body.usage?.input_tokens;
  const outputTokens = body.usage?.output_tokens;

  return {
    engine: 'chatgpt',
    model: typeof body.model === 'string' && body.model ? body.model : req.model,
    query: req.query,
    askedAt,
    ...(req.country ? { country: req.country } : {}),
    searched: searchCalls > 0,
    searchCalls,
    answerText: textParts.join('\n\n').trim(),
    citations,
    sources,
    ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}

export const chatgptEngine: AnswerEngine = {
  id: 'chatgpt',
  host: OPENAI_API_HOST,
  secretPrefix: SECRET_PREFIX,
  defaultSecretRef: DEFAULT_SECRET_REF,

  async ask(req: EngineRequest, ctx: ToolContext, secretRef: SecretRef): Promise<EngineAnswer> {
    const secrets = ctx.secretsResolver;
    const net = ctx.scopedFetch;
    if (!secrets || !net) {
      throw new Error('chatgpt engine requires ctx.secretsResolver and ctx.scopedFetch');
    }
    const apiKey = await secrets.get(secretRef);
    if (!apiKey) throw new EngineNoKeyError(secretRef);

    const askedAt = new Date().toISOString();
    const response = await net.fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: req.model,
        input: req.query,
        tools: [
          {
            type: 'web_search',
            search_context_size: req.searchContextSize,
            ...(req.country
              ? { user_location: { type: 'approximate', country: req.country } }
              : {}),
          },
        ],
        tool_choice: req.requireSearch ? 'required' : 'auto',
        include: ['web_search_call.action.sources'],
        store: false,
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new EngineHttpError(response.status, body.slice(0, MAX_ERROR_BODY_CHARS));
    }

    const data = (await response.json()) as ResponsesApiBody;
    return parseResponse(data, req, askedAt);
  },
};
