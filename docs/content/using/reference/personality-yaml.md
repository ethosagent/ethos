---
title: "Personality config reference"
description: "Every field in a personality's config.yaml and toolset.yaml — model, fs_reach, MCP, plugins, budget, voice, display, safety."
kind: reference
audience: user
slug: personality-yaml
updated: 2026-11-03
---

A [personality](../../getting-started/glossary.md#personality) is a directory at `~/.ethos/personalities/<id>/` with three files:

| File | Purpose |
|---|---|
| `SOUL.md` | First-person identity prose. Loaded as the system-prompt baseline. Free-form markdown. |
| `config.yaml` | Flat `key: value` config — fields documented below. Dotted keys (e.g. `fs_reach.read`) express nested structure. |
| `toolset.yaml` | Flat YAML list of [tool](../../getting-started/glossary.md#tool) names this personality is allowed to call. |

An optional sibling file `tools.yaml` configures a tool per personality. It is **not** a field on the frozen `PersonalityConfig` schema (like `mcp.yaml`, it is a sibling artifact loaded by the registry), so it does not touch `.personality-field-count`. Four tools are configurable, each binding a **named secret**:

```yaml
# ~/.ethos/personalities/researcher/tools.yaml
web_search: { provider: exa, secret: exa-main, recency: 30d }
x_search: { secret: xai-main }
engine_ask: { chatgpt: openai-brand, perplexity: pplx-brand, grok: xai-brand, gemini: gemini-brand }
youtube: { secret: yt-main }
```

`web_search` binds a provider, a named secret, and an optional `recency` default (documented below). `x_search` binds an xAI named secret (`providers/xai/<name>`). `engine_ask` binds one named secret per answer engine, keyed by engine id: `chatgpt` resolves to `providers/openai/<name>` (the same namespace the OpenAI model provider uses), `perplexity` to `providers/perplexity/<name>`, `grok` to `providers/xai/<name>` (the namespace `x_search` also reads) and `gemini` to `providers/gemini/<name>`. An engine the binding does not name falls through to the next layer, and finally to its own operator-wide key — `providers/openai/apiKey`, `providers/perplexity/apiKey`, `providers/xai/apiKey` or `providers/gemini/apiKey`, set in Settings > Keys or from `OPENAI_API_KEY` / `PERPLEXITY_API_KEY` / `XAI_API_KEY` / `GEMINI_API_KEY` — never to another engine's name. The older one-key form `engine_ask: { secret: <name> }` is still read, as the `chatgpt` key and nothing else; it keeps working without an edit, and choosing a ChatGPT key on the personality's Tools tab replaces it with `chatgpt:`. `selectSecretRef` in [`extensions/tools-answer-engines/src/index.ts`](../../../../extensions/tools-answer-engines/src/index.ts) is the resolver. `youtube` binds a Google named secret (`providers/google/<name>`) shared by `youtube_search` and `youtube_comments` — the same API key, the same daily quota; absent, it falls back to `providers/google/apiKey`.

The fifth engine, `microsoft` (Azure AI Foundry with Bing-grounded web search), takes no per-personality binding: `tools.yaml` and `toolSettings` keys for it are ignored. It reads four operator-wide values from Settings > Keys (Microsoft Foundry) or the environment — `providers/microsoft-foundry/projectEndpoint` (`FOUNDRY_PROJECT_ENDPOINT`, of the form `https://<resource>.services.ai.azure.com/api/projects/<project>`), `providers/microsoft-foundry/tenantId` (`AZURE_TENANT_ID`), `providers/microsoft-foundry/clientId` (`AZURE_CLIENT_ID`) and `providers/microsoft-foundry/clientSecret` (`AZURE_CLIENT_SECRET`). The client is an Entra service principal that needs the Foundry User role on the project; an endpoint of any other shape is refused before a request is sent (`responsesUrlOf` in [`extensions/tools-answer-engines/src/engines/microsoft.ts`](../../../../extensions/tools-answer-engines/src/engines/microsoft.ts)).

Two engines come with vendor terms on what may be done with an answer. `gemini` answers are grounded with Google Search, whose terms forbid caching, analysing, training on or otherwise learning from the grounded results: ask Gemini and read the answer, but do not store its answers or score them in a measurement run. `microsoft` answers are grounded with Bing, whose terms require showing the answer's citations as links near it and saying they are internet search results, and forbid building a database or index from them or training on them. Neither engine is in any default engine list, and the `engine_ask` tool description repeats both constraints to the model.

`secret` is a NAME only (resolving to `providers/<provider>/<name>` in the vault) — never a value — so the directory stays shareable and committable ([§V S9](https://github.com/ethosagent/ethos/blob/main/ARCHITECTURE.md)). The personality's own `tools.yaml` is the source of truth; the global `~/.ethos/config.yaml` `toolSettings` map is a fallback layer for personalities (especially read-only built-ins) that don't declare the tool. Resolution order: `tools.yaml` → `toolSettings.<id>` → `toolSettings._default` → the tool's default key. In `config.yaml` each field is its own line — `toolSettings.<id>.x_search.secret: xai-main`, `toolSettings.<id>.engine_ask.perplexity: pplx-brand`.

`quora_search`, `linkedin_search`, and `reddit_web_search` are listed in [`toolset.yaml`](#toolset-yaml) like any other tool, but take no key here — they read the `web_search` binding above instead of one of their own. A personality that binds `web_search` gets Quora, LinkedIn, and Reddit search under the same credential for free; binding a `quora_search:`, `linkedin_search:`, or `reddit_web_search:` key in `tools.yaml` has no effect, because nothing reads it.

All three, and `web_search` itself, render a hit's publication date as ISO `YYYY-MM-DD` at the end of its heading line when the backend supplied one, and render no date at all when it did not — a missing date is never defaulted, guessed, or filled with today's. All four also accept an optional `max_age` argument: a duration written `<number><d|w|m|y>` — `30d`, `2w`, `6m`, `1y`. The grammar is calendar-naive (`d` is 1 day, `w` 7, `m` 30, `y` 365), so the same argument means the same window on every date. `parseMaxAge` in [`extensions/tools-web/src/max-age.ts`](../../../../extensions/tools-web/src/max-age.ts) is the only parser: it trims and lowercases, and rejects a quantity below 1. Each of the four tools turns a rejected argument into an `input_invalid` error rather than searching unfiltered — a dropped filter would return unfiltered results to a caller who believes one is on.

The window is requested upstream in whatever form the chosen backend accepts, mapped in [`extensions/tools-web/src/search-backends.ts`](../../../../extensions/tools-web/src/search-backends.ts):

| Backend | Parameter sent | Exact? |
|---|---|---|
| Exa | `startPublishedDate`, an ISO 8601 instant | Yes — expresses any duration. |
| Tavily | `start_date`, a `YYYY-MM-DD` floor | Yes, to the day. Tavily matches publish date **or** last-updated date, so a stale page edited yesterday can match a short window. |
| Brave | `freshness` as a `YYYY-MM-DDtoYYYY-MM-DD` range | Yes, to the day. The `pd`/`pw`/`pm`/`py` buckets are not used — they could only approximate. |
| SearXNG | `time_range`, buckets `day` / `month` / `year` only | No. Widened to the smallest bucket containing the window, never narrowed; past a year no `time_range` is sent at all. |

SearXNG is the only approximation, and it is disclosed rather than silent: `recencyLimitationNote` (same file) prints a `Note:` line in the rendered output for both inexact cases. Its accuracy is bounded further by a limitation Ethos cannot check — `time_range` support in SearXNG varies with the engines an instance enables, so the bucket is sent but the upstream is not verified to have honoured it.

Whichever backend answered, the window is enforced locally by `filterByMaxAge` (`max-age.ts`), which drops every hit whose publication date reads as outside it. **Hits carrying no readable date pass through.** That is a deliberate limitation: Brave's `page_age` and SearXNG's `publishedDate` are frequently absent, and dropping undated hits would empty the result set exactly where the upstream filter is weakest. A `max_age` result means "nothing dated outside the window", not "everything here is inside it".

The window also takes a persistent default: `recency` on the `web_search` binding, or `toolSettings.<id>.web_search.recency` in `~/.ethos/config.yaml`, written in the same grammar and read by the same `parseMaxAge`. All four tools honour it — the three site tools resolve it from the shared `web_search` binding through their own `resolveSetting`, down the chain they already used for `provider` and `secret`: `tools.yaml` → `toolSettings.<id>` → `toolSettings._default`. Precedence is uniform: call argument `max_age` → bound `recency` → no filter. A stored value that fails the grammar is **ignored**, falling through to no filter — asymmetric with the call argument on purpose, since refusing a bad setting made once elsewhere would break every search the personality runs.

A hand-written `recency` is normalized before it is stored, so `recency: 30D` in `tools.yaml` persists as `30d` rather than being dropped without a word — `normalizeRecency` in [`extensions/personalities/src/index.ts`](../../../../extensions/personalities/src/index.ts) and its twin `normalizeWebSearchRecency` in [`packages/config/src/index.ts`](../../../../packages/config/src/index.ts). Only `web_search` carries a Settings UI control for the key: a closed dropdown (`7d`, `30d`, `90d`, `6m`, `1y`) that clears back to no filter, from the `settingsSchema` on the tool in [`extensions/tools-web/src/index.ts`](../../../../extensions/tools-web/src/index.ts). `quora_search`, `linkedin_search`, and `reddit_web_search` declare no `settingsSchema` of their own, so they are configured through `web_search`'s binding rather than one of theirs; the open grammar stays available to the per-call argument on all four.

`reddit_web_search` is the credential-free route to Reddit: it searches through the `web_search` backend constrained to `reddit.com` and returns post titles, subreddits, URLs, snippets, and whatever publication date the search index recorded — no scores, no comment counts. `reddit_search` and `reddit_thread` speak Reddit's official API instead, which buys engagement counts, subreddit scoping, and a per-post timestamp on every result rather than only on the ones a search index happened to date; they need a Reddit `client_id`/`client_secret` pair bound under Settings > Named Secrets, not a `tools.yaml` key.

## Source {#source}

The schema type lives in [`packages/types/src/personality.ts`](../../../../packages/types/src/personality.ts) (`PersonalityConfig`). The loader / parser lives in [`extensions/personalities/src/index.ts`](../../../../extensions/personalities/src/index.ts) — `parseConfigYaml` (flat keys + the `safety:` nested block), `parseToolsetYaml` (the `- name` list), and `parseToolsYaml` (the optional `tools.yaml` sidecar).

The schema is frozen — adding a top-level field requires the `personality-schema-change` PR label and a bump to `.personality-field-count`. Internal-only fields (`id`, `soulFile`, `skillsDirs`, `metadata`) are populated by the loader and are not user-editable.

## Minimal example {#minimal-example}

```yaml
# ~/.ethos/personalities/researcher/config.yaml
name: Researcher
description: Deep reading and synthesis.
```

```yaml
# ~/.ethos/personalities/researcher/toolset.yaml
- read_file
- write_file
- web_search
```

Memory is always per-personality — each personality reads and writes `~/.ethos/personalities/<id>/MEMORY.md` automatically. No configuration field is required.

## toolset.yaml {#toolset-yaml}

Flat YAML list of tool names. Each entry on its own line, prefixed with `- `. Tools missing from this list are filtered out before the LLM sees them.

```yaml
# ~/.ethos/personalities/researcher/toolset.yaml
- read_file
- write_file
- web_search
- web_extract
- browse_url
```

Notes:

- An empty file (or one with only comments) means the personality runs with no external tools. The file may be omitted entirely for an internal-only personality.
- Tools the personality requests but does not list are rejected by `DefaultToolRegistry` and returned to the LLM as `is_error: true` so the Anthropic tool-result contract remains intact.
- Listing `propose_self_amendment` lets the personality file a request to add or remove entries in this file, or to change its `name`, `description` and `display.emoji` in `config.yaml` (an identity request, which is how a [birth ritual](../how-to/run-a-birth-ritual.md) ends). The request waits for you; nothing changes until you run `ethos personality amendments apply <id>` in a terminal. `ethos personality create` and the web create form add the tool to a new personality's declared toolset for its birth ritual; a toolset left empty is not changed. A personality that does not list the tool is never offered it, and a built-in cannot file. Source: [`extensions/tools-personality-design/src/propose-amendment.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-personality-design/src/propose-amendment.ts). Applying a request rewrites the file as a plain list, dropping comments; the review shows this first. Walkthrough: [Review a personality's change request](../how-to/review-personality-change-requests.md).

## SOUL.md {#ethos-md}

The first-person identity file. Markdown, no front-matter required. Loaded as part of the system prompt at every turn — combined with memory context and the dynamic personality config.

The file is mtime-cached by `FilePersonalityRegistry.loadFromDirectory()`; the loader re-reads it only when the on-disk mtime changes, so editing it during a chat session takes effect on the next turn.

## skills/ {#skills}

Optional sibling directory at `~/.ethos/personalities/<id>/skills/`. Per-personality skill files (markdown with frontmatter). The universal skill scanner picks them up alongside the global `~/.ethos/skills/` directory. Per-personality skills are always loaded unfiltered; global skills are filtered by `capability` mode by default. Set the filter with the dotted [`skills.global_ingest.*` keys](../../building/reference/skills-tools.md#skills-global-ingest); an indented `skills:` block fails the load.

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="name"></a>[name](personality-yaml/identity-and-execution.md#name) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="description"></a>[description](personality-yaml/identity-and-execution.md#description) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="model"></a>[model](personality-yaml/identity-and-execution.md#model) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="provider"></a>[provider](personality-yaml/identity-and-execution.md#provider) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="platform"></a>[platform](personality-yaml/identity-and-execution.md#platform) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="capabilities"></a>[capabilities](personality-yaml/identity-and-execution.md#capabilities) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="streaming-timeout-ms"></a>[streamingTimeoutMs](personality-yaml/identity-and-execution.md#streaming-timeout-ms) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="execution"></a>[execution](personality-yaml/identity-and-execution.md#execution) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="fs-reach"></a>[fs_reach.read / fs_reach.write](personality-yaml/identity-and-execution.md#fs-reach) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="fs-reach-workdir"></a>[fs_reach.workdir](personality-yaml/identity-and-execution.md#fs-reach-workdir) | [Personality config: identity, model and execution fields](personality-yaml/identity-and-execution.md) |
| <a id="mcp-servers"></a>[mcp_servers](personality-yaml/tools-and-context.md#mcp-servers) | [Personality config: MCP, plugins, budget and context fields](personality-yaml/tools-and-context.md) |
| <a id="plugins"></a>[plugins](personality-yaml/tools-and-context.md#plugins) | [Personality config: MCP, plugins, budget and context fields](personality-yaml/tools-and-context.md) |
| <a id="budget-cap-usd"></a>[budgetCapUsd](personality-yaml/tools-and-context.md#budget-cap-usd) | [Personality config: MCP, plugins, budget and context fields](personality-yaml/tools-and-context.md) |
| <a id="context-engine"></a>[context_engine](personality-yaml/tools-and-context.md#context-engine) | [Personality config: MCP, plugins, budget and context fields](personality-yaml/tools-and-context.md) |
| <a id="context-engine-options"></a>[context_engine_options.\*](personality-yaml/tools-and-context.md#context-engine-options) | [Personality config: MCP, plugins, budget and context fields](personality-yaml/tools-and-context.md) |
| <a id="context-layering"></a>[context_layering.*](personality-yaml/tools-and-context.md#context-layering) | [Personality config: MCP, plugins, budget and context fields](personality-yaml/tools-and-context.md) |
| <a id="skill-evolution"></a>[skill_evolution.*](personality-yaml/tools-and-context.md#skill-evolution) | [Personality config: MCP, plugins, budget and context fields](personality-yaml/tools-and-context.md) |
| <a id="safety"></a>[safety](personality-yaml/safety-voice-display.md#safety) | [Personality config: safety, voice, display and outbound policy](personality-yaml/safety-voice-display.md) |
| <a id="safety-approval-mode"></a>[safety.approvalMode](personality-yaml/safety-voice-display.md#safety-approval-mode) | [Personality config: safety, voice, display and outbound policy](personality-yaml/safety-voice-display.md) |
| <a id="safety-observability"></a>[safety.observability.*](personality-yaml/safety-voice-display.md#safety-observability) | [Personality config: safety, voice, display and outbound policy](personality-yaml/safety-voice-display.md) |
| <a id="voice"></a>[voice.\*](personality-yaml/safety-voice-display.md#voice) | [Personality config: safety, voice, display and outbound policy](personality-yaml/safety-voice-display.md) |
| <a id="display"></a>[display.\*](personality-yaml/safety-voice-display.md#display) | [Personality config: safety, voice, display and outbound policy](personality-yaml/safety-voice-display.md) |
| <a id="mcp-export"></a>[mcp_export.\*](personality-yaml/safety-voice-display.md#mcp-export) | [Personality config: safety, voice, display and outbound policy](personality-yaml/safety-voice-display.md) |
| <a id="outbound-policy"></a>[outbound_policy.\*](personality-yaml/safety-voice-display.md#outbound-policy) | [Personality config: safety, voice, display and outbound policy](personality-yaml/safety-voice-display.md) |

## See also {#see-also}

- [`config.yaml` reference](./config-yaml.md) — the user-level `~/.ethos/config.yaml` that picks which personality runs (different file, different schema).
- [CLI reference](./cli.md#ethos-personality) — the `ethos personality` subcommands that scaffold and edit these files.
- [Glossary: personality](../../getting-started/glossary.md#personality) — one-line definition shared across every page that names the construct.
- [Glossary: fs_reach](../../getting-started/glossary.md#fs-reach) — the path-allowlist field this file declares; backed by `ScopedStorage`.
- [Run agent tools on a remote host](../how-to/run-tools-over-ssh.md) — the `execution: remote` requirement end to end, and what the remote host is exposed to.
- [Retrieve files the agent wrote](../how-to/retrieve-agent-files.md) — `fs_reach.workdir` in practice, on a headless deployment.
- [Local voice: Kokoro TTS + Whisper large v3 STT](../how-to/local-voice.md) — configure the providers this file's `voice.*` block picks between.
- [`outbound_policy` reference](../../building/reference/outbound-policy.md) — the approval outbox this file's `outbound_policy` block switches on.
