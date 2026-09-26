import type { ScopedFetch, SecretRef, ToolContext } from '@ethosagent/types';
import { isRecord, MAX_ERROR_BODY_CHARS, orderCitations, type RawCitation } from './citations';
import {
  type AnswerEngine,
  type EngineAnswer,
  EngineHttpError,
  EngineNoKeyError,
  type EngineRequest,
} from './types';

// ---------------------------------------------------------------------------
// microsoft — Azure AI Foundry's Responses API
// (`POST {projectEndpoint}/openai/v1/responses`) with the Bing-grounded
// `web_search` tool. Shapes as documented on 2026-09-18
// (plan/phases/engine-ask-grok-gemini-microsoft.md §4.3, §5.3): the same
// Responses shape as chatgpt.ts, except that `url_citation`s carry no `title`
// in either documented REST payload, one payload variant carries no offsets at
// all, and Bing grounding "doesn't return the tool output to developers and end
// users" — so `sources` is always `[]` and nothing here looks for it.
//
// Auth is an Entra bearer token, not an API key: client credentials against
// `login.microsoftonline.com`, scope `https://ai.azure.com/.default` (D17),
// minted through `ctx.scopedFetch` like every other request.
//
// Bing's use-and-display terms bind the CALLER: show every citation as a
// hyperlink near the answer, say the results are internet search results, and
// never build a database or index from them or train on them (D15) — `argNote`
// says so, and `microsoft` is in no GEO or brand default engine list.
// ---------------------------------------------------------------------------

const SECRET_PREFIX = 'providers/microsoft-foundry/';
const PROJECT_ENDPOINT_REF = 'providers/microsoft-foundry/projectEndpoint';
const TENANT_ID_REF = 'providers/microsoft-foundry/tenantId';
const CLIENT_ID_REF = 'providers/microsoft-foundry/clientId';
const CLIENT_SECRET_REF = 'providers/microsoft-foundry/clientSecret';

const ENTRA_HOST = 'login.microsoftonline.com';
const FOUNDRY_HOST_SUFFIX = '.services.ai.azure.com';
const TOKEN_SCOPE = 'https://ai.azure.com/.default';
/** A cached token is re-minted once it is within this much of expiry (D17). */
const TOKEN_EXPIRY_MARGIN_MS = 300_000;

/**
 * Default Foundry DEPLOYMENT name — the string the Foundry call carries as
 * `model`. A deployment is named by the operator, so this is only a guess at
 * the common case (a deployment named after its model); set
 * `FOUNDRY_ANSWER_ENGINE_DEPLOYMENT` or `createEngineAskTool({ models: {
 * microsoft } })` to the real one.
 */
export const MICROSOFT_DEFAULT_DEPLOYMENT = 'gpt-5.5';

const NO_KEY_MESSAGE =
  'No Microsoft Foundry credential configured — engine "microsoft" needs a Foundry project endpoint and an Entra service principal holding the Foundry User role on that project. Set all four in Settings → Keys (Microsoft Foundry): providers/microsoft-foundry/projectEndpoint, tenantId, clientId and clientSecret — or FOUNDRY_PROJECT_ENDPOINT, AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET. A rejected token or a failed token mint also shows this message.';

// ---------------------------------------------------------------------------
// Token cache — per process, keyed `${tenantId}:${clientId}` (D17).
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Empties the module-level Entra token cache. For tests only: production never
 * needs it, because a Foundry 401 drops its own entry.
 */
export function resetMicrosoftTokenCacheForTests(): void {
  tokenCache.clear();
}

async function mintToken(
  net: ScopedFetch,
  tenantId: string,
  clientId: string,
  clientSecret: string,
  signal: AbortSignal,
): Promise<string> {
  const key = `${tenantId}:${clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > TOKEN_EXPIRY_MARGIN_MS) return cached.token;

  const response = await net.fetch(
    `https://${ENTRA_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: TOKEN_SCOPE,
      }).toString(),
      signal,
    },
  );
  // A mint failure is a CREDENTIAL failure (D18): it surfaces as not_available
  // naming the four refs and the role, never as an Entra error body quoted at
  // an LLM.
  if (!response.ok) throw new EngineNoKeyError(CLIENT_SECRET_REF);
  const body: unknown = await response.json();
  const token = isRecord(body) ? body.access_token : undefined;
  if (typeof token !== 'string' || !token) {
    throw new Error('Microsoft Entra token response carried no access_token');
  }
  const expiresIn = isRecord(body) && typeof body.expires_in === 'number' ? body.expires_in : 0;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

/**
 * The Foundry Responses URL, or an Error naming the expected shape. Refused
 * BEFORE any fetch (D20): a mistyped endpoint would otherwise surface as a
 * `HOST_NOT_ALLOWED` from `ScopedFetchImpl.fetch`, which says nothing about
 * what was typed wrong. `*.services.ai.azure.com` is the declared host, matched
 * by `ScopedFetchImpl.isHostAllowed` (packages/core/src/scoped/scoped-fetch.ts).
 */
function responsesUrlOf(projectEndpoint: string): string {
  const trimmed = projectEndpoint.trim();
  const url = URL.canParse(trimmed) ? new URL(trimmed) : undefined;
  const host = url?.hostname.toLowerCase() ?? '';
  if (
    url?.protocol !== 'https:' ||
    !host.endsWith(FOUNDRY_HOST_SUFFIX) ||
    host.length <= FOUNDRY_HOST_SUFFIX.length
  ) {
    throw new Error(
      `Microsoft Foundry project endpoint at ${PROJECT_ENDPOINT_REF} must look like https://<resource>${FOUNDRY_HOST_SUFFIX}/api/projects/<project> — the stored value does not.`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/openai/v1/responses`;
}

export function parseMicrosoftResponse(
  body: unknown,
  req: EngineRequest,
  askedAt: string,
): EngineAnswer {
  const root = isRecord(body) ? body : {};
  const output = Array.isArray(root.output) ? root.output : [];

  // Reported from the response only: a `required` call that returned
  // citations and no `web_search_call` item still reports 0 (parent D4).
  let searchCalls = 0;
  const textParts: string[] = [];
  const raw: RawCitation[] = [];
  let offset = 0;

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === 'web_search_call') {
      searchCalls += 1;
      continue;
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (!isRecord(c) || c.type !== 'output_text' || typeof c.text !== 'string') continue;
      if (Array.isArray(c.annotations)) {
        for (const a of c.annotations) {
          if (!isRecord(a) || a.type !== 'url_citation' || typeof a.url !== 'string') continue;
          // No `title` in the REST payload, so none is set — and none is ever
          // synthesised from the URL (D8). Without offsets the stable sort
          // keeps annotation array order.
          raw.push({
            url: a.url,
            keys: [
              typeof a.start_index === 'number' ? offset + a.start_index : Number.POSITIVE_INFINITY,
            ],
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
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;

  return {
    engine: 'microsoft',
    model: typeof root.model === 'string' && root.model ? root.model : req.model,
    query: req.query,
    askedAt,
    ...(req.country ? { country: req.country } : {}),
    searched: searchCalls > 0,
    searchCalls,
    answerText: textParts.join('\n\n').trim(),
    citations: orderCitations(raw, req.maxCitations),
    // Always empty: Bing grounding does not return its tool output (§4.3).
    sources: [],
    ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}

export const microsoftEngine: AnswerEngine = {
  id: 'microsoft',
  label: 'Microsoft',
  hosts: [ENTRA_HOST, `*${FOUNDRY_HOST_SUFFIX}`],
  secretPrefix: SECRET_PREFIX,
  // The value `ask()` receives; the adapter reads the other three itself.
  defaultSecretRef: CLIENT_SECRET_REF,
  // Not bindable (plan engine-ask-per-engine-bindings D9): four operator-wide
  // exact refs, no picker, and every personality binding is ignored.
  bindable: false,
  operatorSecretRefs: [PROJECT_ENDPOINT_REF, TENANT_ID_REF, CLIENT_ID_REF, CLIENT_SECRET_REF],
  getKeyUrl: 'https://ai.azure.com/',
  supports: { country: true, searchContextSize: true, requireSearch: true },
  argNote:
    "microsoft answers are Bing-grounded: Bing's terms require showing its citations as links near the answer and saying they are web search results, and forbid storing or indexing them.",
  defaultModel: MICROSOFT_DEFAULT_DEPLOYMENT,
  modelEnvVar: 'FOUNDRY_ANSWER_ENGINE_DEPLOYMENT',
  noKeyMessage: NO_KEY_MESSAGE,

  async ask(req: EngineRequest, ctx: ToolContext, secretRef: SecretRef): Promise<EngineAnswer> {
    const secrets = ctx.secretsResolver;
    const net = ctx.scopedFetch;
    if (!secrets || !net) {
      throw new Error('microsoft engine requires ctx.secretsResolver and ctx.scopedFetch');
    }
    const projectEndpoint = await secrets.get(PROJECT_ENDPOINT_REF);
    if (!projectEndpoint) throw new EngineNoKeyError(PROJECT_ENDPOINT_REF);
    const tenantId = await secrets.get(TENANT_ID_REF);
    if (!tenantId) throw new EngineNoKeyError(TENANT_ID_REF);
    const clientId = await secrets.get(CLIENT_ID_REF);
    if (!clientId) throw new EngineNoKeyError(CLIENT_ID_REF);
    const clientSecret = await secrets.get(secretRef);
    if (!clientSecret) throw new EngineNoKeyError(secretRef);

    const url = responsesUrlOf(projectEndpoint);
    const token = await mintToken(net, tenantId, clientId, clientSecret, ctx.abortSignal);

    const askedAt = new Date().toISOString();
    const response = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      // A 401 drops the cached token so the NEXT call mints fresh — a rotated
      // secret self-heals — and is never retried within this call (parent D2).
      // The tool maps the 401 to not_available.
      if (response.status === 401) tokenCache.delete(`${tenantId}:${clientId}`);
      const text = await response.text().catch(() => '');
      throw new EngineHttpError('Microsoft', response.status, text.slice(0, MAX_ERROR_BODY_CHARS));
    }

    return parseMicrosoftResponse(await response.json(), req, askedAt);
  },
};
