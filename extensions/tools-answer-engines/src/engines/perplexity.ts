import type { SecretRef, ToolContext } from '@ethosagent/types';
import {
  type AnswerEngine,
  type Citation,
  type EngineAnswer,
  EngineHttpError,
  EngineNoKeyError,
  type EngineRequest,
} from './types';
import { domainOf } from './url';

// ---------------------------------------------------------------------------
// perplexity — Perplexity's Agent API (`POST https://api.perplexity.ai/v1/agent`)
// with the `web_search` tool type. Request and response shapes were verified
// against docs.perplexity.ai on 2026-09-17 (plan/phases/engine-ask-perplexity.md §4).
// The older Sonar chat-completions surface (`/v1/sonar`) is deprecated and
// supported only until 2026-09-27, which is why nothing here uses it.
//
// The question is the ENTIRE input — no `instructions`, no system prompt
// (parent plan D3); the preset's own prompt is Perplexity's product behaviour,
// not ours.
// ---------------------------------------------------------------------------

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/v1/agent';
const PERPLEXITY_API_HOST = 'api.perplexity.ai';
const SECRET_PREFIX = 'providers/perplexity/';
const DEFAULT_SECRET_REF = 'providers/perplexity/apiKey';

/** Non-2xx bodies are cut to this many characters before they reach an error. */
const MAX_ERROR_BODY_CHARS = 500;

/**
 * `low` is the Agent API preset Perplexity's own migration table maps
 * `sonar-pro` onto — everyday research with inline citations. Overridable per
 * process via the `PERPLEXITY_ANSWER_ENGINE_PRESET` env var, or per instance
 * via `createEngineAskTool({ models: { perplexity } })`, because a preset
 * roster moves faster than this file does.
 */
export const PERPLEXITY_DEFAULT_PRESET = 'low';

// Both marker dialects appear depending on the preset (`fast` emits `[1]`,
// `low` and above emit `[web:1]`), and three digits is a deliberate bound
// rather than `\d+` so a year like `[2026]` in prose is not read as citation
// 2026.
const CITATION_MARKER_RE = /\[(?:web:)?(\d{1,3})\]/g;

interface AgentSearchResult {
  id?: unknown;
  url?: unknown;
  title?: unknown;
}

interface AgentContentPart {
  type?: string;
  text?: unknown;
}

interface AgentOutputItem {
  type?: string;
  results?: unknown;
  content?: unknown;
}

interface AgentApiBody {
  model?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    tool_calls_details?: { search_web?: { invocation?: unknown } | null } | null;
  } | null;
}

// Each one only asserts "this is an object", because every field on these
// interfaces is optional and `unknown`-typed and the real narrowing happens at
// each field's own `typeof` guard below.
function isOutputItem(value: unknown): value is AgentOutputItem {
  return typeof value === 'object' && value !== null;
}

function isSearchResult(value: unknown): value is AgentSearchResult {
  return typeof value === 'object' && value !== null;
}

function isContentPart(value: unknown): value is AgentContentPart {
  return typeof value === 'object' && value !== null;
}

function parseResponse(body: AgentApiBody, req: EngineRequest, askedAt: string): EngineAnswer {
  let searchResultItems = 0;
  const sources: EngineAnswer['sources'] = [];
  const textParts: string[] = [];
  const byId = new Map<number, { url: string; title?: string }>();

  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!isOutputItem(item)) continue;

    if (item.type === 'search_results') {
      searchResultItems += 1;
      if (Array.isArray(item.results)) {
        for (const entry of item.results) {
          if (!isSearchResult(entry)) continue;
          if (typeof entry.url !== 'string') continue;
          const url = entry.url;
          const domain = domainOf(url);
          if (!domain) continue;
          sources.push({ url, domain });
          // FIRST-ID-WINS: two `search_results` items can reuse an id, and
          // preferring the later one would be a guess dressed as precision, so
          // the first one recorded is kept.
          if (typeof entry.id === 'number' && !byId.has(entry.id)) {
            byId.set(entry.id, {
              url,
              ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
            });
          }
        }
      }
      continue;
    }

    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isContentPart(part)) continue;
        if (part.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0) {
          textParts.push(part.text);
        }
      }
    }

    // Every other item type is skipped and is never fatal. The `low` preset
    // enables the `fetch_url` tool, so a `fetch_url_results` item is routine,
    // not hypothetical, alongside reasoning and tool-call items.
  }

  const answerText = textParts.join('\n\n').trim();

  // The markers stay in `answerText` verbatim — the answer is returned as the
  // engine wrote it.
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const match of answerText.matchAll(CITATION_MARKER_RE)) {
    if (citations.length >= req.maxCitations) break;
    const digits = match[1];
    if (digits === undefined) continue;
    const id = Number.parseInt(digits, 10);
    const entry = byId.get(id);
    // Never invent a citation — the docs say the markers are prompt-dependent
    // and the `search_results` entries are the source of truth, so a marker
    // with no matching id is ignored rather than carried as a placeholder.
    if (!entry) continue;
    // URL IDENTITY IS EXACT STRING EQUALITY — no trailing slash, fragment,
    // case or query-string normalisation. `?page=2`, `#section-3` and a
    // trailing slash can each name a different resource, so two citations that
    // MIGHT be two documents stay two; the cost is the reverse, the same
    // document under two spellings surviving as two entries, which is the safe
    // direction for a tool whose output is evidence. `domain` is normalised
    // (lower-cased, `www.` stripped) for grouping only; it is never the
    // identity key.
    if (seen.has(entry.url)) continue;
    const domain = domainOf(entry.url);
    if (!domain) continue;
    seen.add(entry.url);
    citations.push({
      url: entry.url,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      domain,
      position: citations.length + 1,
    });
  }

  // The response's own invocation count is preferred and the item count is the
  // fallback.
  const invocation = body.usage?.tool_calls_details?.search_web?.invocation;
  const searchCalls = typeof invocation === 'number' ? invocation : searchResultItems;

  const inputTokens = body.usage?.input_tokens;
  const outputTokens = body.usage?.output_tokens;

  return {
    engine: 'perplexity',
    // Under a preset the body names the model the preset actually resolved to,
    // which is the honest answer to "what answered this".
    model: typeof body.model === 'string' && body.model ? body.model : req.model,
    query: req.query,
    askedAt,
    ...(req.country ? { country: req.country } : {}),
    searched: searchCalls > 0,
    searchCalls,
    answerText,
    citations,
    sources,
    // `usage.cost` is deliberately NOT mapped — cost is passed through as
    // tokens (parent D10), and a provider-computed dollar figure on the record
    // would be a second, divergent pricing path.
    ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}

export const perplexityEngine: AnswerEngine = {
  id: 'perplexity',
  label: 'Perplexity',
  host: PERPLEXITY_API_HOST,
  secretPrefix: SECRET_PREFIX,
  defaultSecretRef: DEFAULT_SECRET_REF,
  // An EXACT ref, not a `providers/perplexity/*` prefix — see the plan's §8
  // roster reasoning (a prefix grant would publish a mislabelled namespace).
  secretGrant: 'providers/perplexity/apiKey',
  defaultModel: PERPLEXITY_DEFAULT_PRESET,
  modelEnvVar: 'PERPLEXITY_ANSWER_ENGINE_PRESET',
  noKeyMessage:
    'No Perplexity key configured — add a Perplexity key in Settings → Keys (Perplexity), then use engine: "perplexity", or set PERPLEXITY_API_KEY.',

  async ask(req: EngineRequest, ctx: ToolContext, secretRef: SecretRef): Promise<EngineAnswer> {
    const secrets = ctx.secretsResolver;
    const net = ctx.scopedFetch;
    if (!secrets || !net) {
      throw new Error('perplexity engine requires ctx.secretsResolver and ctx.scopedFetch');
    }
    const apiKey = await secrets.get(secretRef);
    if (!apiKey) throw new EngineNoKeyError(secretRef);

    const askedAt = new Date().toISOString();
    const response = await net.fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // `req.requireSearch` is deliberately NOT sent: the Agent API has no
      // per-request "must search" switch, and `searched` is still reported
      // from the response.
      body: JSON.stringify({
        preset: req.model,
        input: req.query,
        tools: [
          {
            type: 'web_search',
            search_context_size: req.searchContextSize,
            ...(req.country ? { user_location: { country: req.country } } : {}),
          },
        ],
        store: false,
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new EngineHttpError('Perplexity', response.status, body.slice(0, MAX_ERROR_BODY_CHARS));
    }

    const data: AgentApiBody = await response.json();
    return parseResponse(data, req, askedAt);
  },
};
