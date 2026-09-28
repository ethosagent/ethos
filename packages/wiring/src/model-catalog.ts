import type { ModelProfile } from '@ethosagent/types';

export type { ModelProfile, ModelSampling } from '@ethosagent/types';

export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  label: string;
  contextWindow: number;
  default?: boolean;
  /** §7 keystone — optional per-model profile (sampling defaults, tool-call
   *  format, output-token cap). Absent for models without a profile, in which
   *  case no defaults are applied and behavior is byte-identical to today. */
  profile?: ModelProfile;
  /** ISO date (`YYYY-MM-DD`, UTC) the vendor retires this model. A row that
   *  carries it is deprecated but still served: its `label` says
   *  `deprecated — retires <date>`, and from that date on it drops out of every
   *  listing (`getModelsForProvider`, `listedModels`) while the lookups
   *  (`lookupContextWindow`, `lookupProfile`, `lookupCatalogModel`) keep
   *  answering, so a config that names it keeps working until the vendor turns
   *  it off. Pinned by __tests__/model-catalog-retirement.test.ts. */
  retiresOn?: string;
}

/** Context window below which a warning is shown in the model picker. */
export const MIN_CONTEXT_WINDOW = 64_000;

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // Anthropic — source: Anthropic's model reference (models overview, re-verified
  // 2026-09-28): https://platform.claude.com/docs/en/models/overview, plus the
  // per-model pages for the two 200K legacy rows (sonnet-4-5, opus-4-5: 64K
  // max output each). `claude-opus-5-5` is the default because the overview
  // says to start with it for most workloads.
  // `contextWindow` and `profile.maxOutputTokens` are the documented context
  // window and max output per model. The live source is the Models API:
  // `GET /v1/models/{id}` → `max_input_tokens` / `max_tokens`. Wiring threads
  // the cap to `AnthropicProvider` as `max_tokens` (`createLLMFromRegistry` and
  // the rotation pool in packages/wiring/src/index.ts, pinned by
  // __tests__/anthropic-output-cap-catalog.test.ts); `models.anthropic/<id>.
  // maxOutputTokens` in ~/.ethos/config.yaml still wins (`mergeModelProfile`
  // below). Every Anthropic row carries a cap (the same test checks each one);
  // a model the catalog does not list sends `DEFAULT_MAX_OUTPUT_TOKENS` (8096,
  // extensions/llm-anthropic/src/index.ts). The provider always streams, so a
  // 128K `max_tokens` never meets the SDK's non-streaming timeout guard.
  // Provider-keyed: the OpenRouter and Azure Claude rows below carry no cap.
  {
    providerId: 'anthropic',
    modelId: 'claude-fable-5-1',
    label: 'most capable',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-5-5',
    label: 'recommended for most work',
    contextWindow: 1_000_000,
    default: true,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-5',
    label: 'fast, balanced',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5',
    label: 'cheapest, fast',
    contextWindow: 200_000,
    profile: { maxOutputTokens: 64_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    label: 'prior gen',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-fable-5',
    label: 'prior gen',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-8',
    label: 'prior gen',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-7',
    label: 'prior gen',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-6',
    label: 'prior gen',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    label: 'prior gen',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-mythos-5-1',
    label: 'Project Glasswing access only',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-mythos-5',
    label: 'Project Glasswing access only, prior gen',
    contextWindow: 1_000_000,
    profile: { maxOutputTokens: 128_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    label: 'dated snapshot of claude-haiku-4-5',
    contextWindow: 200_000,
    profile: { maxOutputTokens: 64_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    label: 'prior gen',
    contextWindow: 200_000,
    profile: { maxOutputTokens: 64_000 },
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-5-20251101',
    label: 'prior gen',
    contextWindow: 200_000,
    profile: { maxOutputTokens: 64_000 },
  },
  // OpenAI — source: https://developers.openai.com/api/docs/models (re-verified
  // 2026-09-28: flagship gpt-6-astra / gpt-6-sol / gpt-6-luna, 1.05M context
  // each). None of the older rows is deprecated on the API.
  {
    providerId: 'openai',
    modelId: 'gpt-6-astra',
    label: 'top reasoning',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-6-sol',
    label: 'flagship, everyday',
    contextWindow: 1_050_000,
    default: true,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-6-luna',
    label: 'fast, cheap',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    label: 'prior gen, complex work',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.6-terra',
    label: 'prior gen, balanced',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.6-luna',
    label: 'prior gen, fast',
    contextWindow: 1_050_000,
  },
  { providerId: 'openai', modelId: 'gpt-5.5', label: 'prior gen', contextWindow: 1_050_000 },
  { providerId: 'openai', modelId: 'gpt-5.4', label: 'prior gen', contextWindow: 1_050_000 },
  {
    providerId: 'openai',
    modelId: 'gpt-5.4-mini',
    label: 'prior gen, compact',
    contextWindow: 400_000,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.3-codex',
    label: 'prior gen, code-specialized',
    contextWindow: 400_000,
  },
  // OpenRouter top picks — ids and `context_length` from
  // https://openrouter.ai/api/v1/models (re-verified 2026-09-28). OpenRouter
  // writes Claude 4.6+ versions with a dot (`anthropic/claude-opus-5.5`).
  // `google/gemini-2.5-pro` carries the API's own `expiration_date`.
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet',
    contextWindow: 1_000_000,
    default: true,
  },
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-opus-5.5',
    label: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-opus-5',
    label: 'Claude Opus',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'openai/gpt-6-sol',
    label: 'GPT-6 Sol',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'openai/gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'openai/gpt-6-astra',
    label: 'GPT-6 Astra',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'openrouter',
    modelId: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro, deprecated — retires 2026-10-20',
    contextWindow: 1_048_576,
    retiresOn: '2026-10-20',
  },
  {
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash, cheapest',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-v4-flash-0731',
    label: 'DeepSeek V4 Flash',
    contextWindow: 1_310_720,
  },
  {
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-v4-pro-0813',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'openrouter',
    modelId: 'qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'qwen/qwen3.8-max-0902',
    label: 'Qwen 3.8 Max',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-4-maverick',
    label: 'Llama 4 Maverick',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'openrouter',
    modelId: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B, open weights',
    contextWindow: 131_072,
  },
  {
    providerId: 'openrouter',
    modelId: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    contextWindow: 262_144,
  },
  // Azure AI Foundry — source: https://ai.azure.com/catalog/models
  // The `modelId` is the deployment name in Azure. By convention Azure admins
  // name a deployment after the base model. If yours uses a custom name
  // (e.g. `prod-chat-v2`), pick any entry here and edit `model:` in
  // ~/.ethos/config.yaml. Context windows are nominal; verify per-deployment.
  // Re-verified 2026-09-28 against Microsoft Learn: "Foundry Models sold by
  // Azure" (OpenAI + DeepSeek rows) and "Claude models in Microsoft Foundry"
  // (Claude rows). The Claude rows added here are the ones that page lists as
  // Hosted on Azure; Opus 4.6 and Sonnet 4.6 are Hosted on Anthropic only.
  {
    providerId: 'azure',
    modelId: 'gpt-6-astra',
    label: 'top reasoning',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-6-sol',
    label: 'flagship, everyday',
    contextWindow: 1_050_000,
    default: true,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-6-luna',
    label: 'fast, cheap',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.6-sol',
    label: 'prior gen, complex work',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.6-terra',
    label: 'prior gen, balanced',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.6-luna',
    label: 'prior gen, fast',
    contextWindow: 1_050_000,
  },
  { providerId: 'azure', modelId: 'gpt-5.5', label: 'prior gen', contextWindow: 1_050_000 },
  { providerId: 'azure', modelId: 'gpt-5.4', label: 'prior gen', contextWindow: 1_050_000 },
  {
    providerId: 'azure',
    modelId: 'gpt-5.4-mini',
    label: 'prior gen, compact',
    contextWindow: 400_000,
  },
  {
    providerId: 'azure',
    modelId: 'gpt-5.3-codex',
    label: 'prior gen, code-specialized',
    contextWindow: 400_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-opus-5-5',
    label: 'Claude Opus 5.5 on Azure',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-sonnet-5',
    label: 'Claude Sonnet 5 on Azure',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5 on Azure',
    contextWindow: 200_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-opus-4-6',
    label: 'Claude Opus 4.6, hosted on Anthropic, prior gen',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6, hosted on Anthropic, prior gen',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'DeepSeek-V4-Pro',
    label: 'reasoning MoE',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'azure',
    modelId: 'DeepSeek-V4-Flash',
    label: 'fast reasoning MoE',
    contextWindow: 1_000_000,
  },
  // Gemini — source: https://ai.google.dev/gemini-api/docs/models (re-verified
  // 2026-09-28) and the per-model pages for 3.1 Flash-Lite and 3.6 Flash. The
  // 2.5 rows have no shutdown date, but Google limits them to accounts that
  // already used them and no longer lists them for new projects.
  {
    providerId: 'gemini',
    modelId: 'gemini-3.8-flash',
    label: 'fast, balanced',
    contextWindow: 1_048_576,
    default: true,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.1-pro-preview',
    label: 'most capable',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.5-flash-lite',
    label: 'cheapest, fast',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.1-flash-lite',
    label: 'cheap, fast',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.7-flash',
    label: 'prior gen',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.6-flash',
    label: 'prior gen',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.5-flash',
    label: 'prior gen',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-2.5-pro',
    label: 'legacy, existing users only',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-2.5-flash',
    label: 'legacy, existing users only',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-2.5-flash-lite',
    label: 'legacy, existing users only',
    contextWindow: 1_048_576,
  },
  // Groq — source: https://console.groq.com/docs/models and /docs/deprecations
  // (re-verified 2026-09-28). `llama-3.1-8b-instant` and `llama-3.3-70b-versatile`
  // are gone: the deprecations page gives both a 2026-08-16 shutdown for free and
  // developer-tier usage (replacements openai/gpt-oss-20b and openai/gpt-oss-120b);
  // only enterprise committed-spend contracts keep them.
  {
    providerId: 'groq',
    modelId: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B, open weights',
    contextWindow: 131_072,
    default: true,
  },
  {
    providerId: 'groq',
    modelId: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B, fastest, cheapest',
    contextWindow: 131_072,
  },
  {
    providerId: 'groq',
    modelId: 'qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B, preview',
    contextWindow: 131_072,
  },
  // DeepSeek — source: https://api-docs.deepseek.com/quick_start/pricing
  // (re-verified 2026-09-28). The page gives both models a "1M" context; read
  // literally as 1,000,000. `deepseek-chat` and `deepseek-reasoner` were
  // retired 2026-07-24 (https://api-docs.deepseek.com/updates/).
  {
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    label: 'V4.1 Flash, fast, cheap',
    contextWindow: 1_000_000,
    default: true,
  },
  {
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
    label: 'V4 Pro, most capable',
    contextWindow: 1_000_000,
  },
  // Ollama — static fallbacks; the live /api/tags list wins when reachable.
  // contextWindow values are conservative ARCHITECTURE maxima; the Lane 0
  // resolution caps catalog values for local runtimes at ARCH_WINDOW_CAP_TOKENS
  // (32,768, local-models.ts) because the SERVED window is whatever num_ctx
  // Ollama allocated — the /api/ps probe reports the truth, and these rows are
  // only the fallback behind it. `deepseek-v4-flash` is gone: ollama.com says it
  // was retired 2026-08-27 (re-verified 2026-09-28).
  {
    providerId: 'ollama',
    modelId: 'qwen3.8:27b',
    label: '27B, vision',
    contextWindow: 262_144,
    default: true,
  },
  {
    providerId: 'ollama',
    modelId: 'gpt-oss:20b',
    label: '20B, open weights',
    contextWindow: 131_072,
  },
  {
    providerId: 'ollama',
    modelId: 'gpt-oss:120b',
    label: '120B, open weights',
    contextWindow: 131_072,
  },
  {
    providerId: 'ollama',
    modelId: 'llama4:scout',
    label: 'Llama 4 Scout',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'ollama',
    modelId: 'llama3.2',
    label: '3B, small, fast',
    // Llama 3.2 (1B/3B) supports a 128k context window. Kept realistic so the
    // small local option clears the Phase 1d 16k agentic-tool-use floor (a
    // silently-tiny Ollama num_ctx still fails loudly at provider init).
    contextWindow: 131_072,
  },
  { providerId: 'ollama', modelId: 'mistral', label: '7B', contextWindow: 32_768 },
  { providerId: 'ollama', modelId: 'qwen3', label: '8B, hybrid reasoning', contextWindow: 40_960 },
  { providerId: 'ollama', modelId: 'gemma3', label: '4B, multimodal', contextWindow: 131_072 },
  { providerId: 'ollama', modelId: 'phi4', label: '14B', contextWindow: 16_384 },
  {
    providerId: 'ollama',
    modelId: 'deepseek-r1',
    label: 'reasoning, distilled',
    contextWindow: 131_072,
  },
  { providerId: 'ollama', modelId: 'llama3.3', label: '70B', contextWindow: 131_072 },
  // Mistral — direct API. baseUrl: https://api.mistral.ai/v1
  // Set `baseUrl` in ~/.ethos/config.yaml; OpenAICompatProvider handles the
  // rest. Context windows are nominal — verify against the official pricing
  // page if a deployment behaves smaller than expected. The `-latest` rows keep
  // their old windows: Mistral's docs (re-verified 2026-09-28) do not say which
  // dated model each alias points at. `mistral-medium-3-5` is from its model
  // card; `pixtral-large-latest` is gone (Pixtral Large 24.11 retired 2026-05-31).
  {
    providerId: 'mistral',
    modelId: 'mistral-large-latest',
    label: 'most capable',
    contextWindow: 128_000,
    default: true,
  },
  {
    providerId: 'mistral',
    modelId: 'mistral-medium-latest',
    label: 'fast, balanced',
    contextWindow: 128_000,
  },
  {
    providerId: 'mistral',
    modelId: 'mistral-small-latest',
    label: 'cheapest, fast',
    contextWindow: 32_000,
  },
  {
    providerId: 'mistral',
    modelId: 'codestral-latest',
    label: 'code-specialized',
    contextWindow: 32_000,
  },
  {
    providerId: 'mistral',
    modelId: 'mistral-medium-3-5',
    label: 'Medium 3.5, multimodal, agentic',
    contextWindow: 256_000,
  },
  {
    providerId: 'mistral',
    modelId: 'ministral-8b-latest',
    label: 'compact',
    contextWindow: 128_000,
  },
  // Together AI — direct API. baseUrl: https://api.together.xyz/v1
  // Model IDs are namespaced (`vendor/model-name`) and required verbatim.
  // Source: https://docs.together.ai/docs/serverless-models (re-verified
  // 2026-09-28); the Llama 3.1, Mixtral, Qwen 2.5 and DeepSeek-V3 rows this
  // block used to carry are no longer served (docs.together.ai/docs/deprecations).
  {
    providerId: 'together',
    modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    label: 'Llama 3.3 70B Turbo',
    contextWindow: 131_072,
    default: true,
  },
  {
    providerId: 'together',
    modelId: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B, open weights',
    contextWindow: 131_072,
  },
  {
    providerId: 'together',
    modelId: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'together',
    modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
    label: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'together',
    modelId: 'moonshotai/Kimi-K3',
    label: 'Kimi K3',
    contextWindow: 1_048_576,
  },
  {
    providerId: 'together',
    modelId: 'Qwen/Qwen3.7-Plus',
    label: 'Qwen 3.7 Plus',
    contextWindow: 1_000_000,
  },
  // Fireworks AI — direct API. baseUrl: https://api.fireworks.ai/inference/v1
  // The `accounts/fireworks/models/` prefix is canonical and required.
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    label: 'Llama 3.3 70B',
    // 131,072 per fireworks.ai/models/fireworks/llama-v3p3-70b-instruct (2026-09-28).
    contextWindow: 131_072,
    default: true,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/qwen2p5-72b-instruct',
    label: 'Qwen 2.5 72B',
    contextWindow: 32_768,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/deepseek-v3',
    label: 'DeepSeek V3',
    contextWindow: 128_000,
  },
  {
    providerId: 'fireworks',
    modelId: 'accounts/fireworks/models/firefunction-v2',
    label: 'FireFunction v2',
    contextWindow: 8_192,
  },
  // Codex (ChatGPT OAuth transport) — source: https://learn.chatgpt.com/docs/models
  // (the redirect target of developers.openai.com/codex/models, re-verified
  // 2026-09-28): gpt-6-sol is recommended for everyday coding, and gpt-5.5
  // retires from ChatGPT and Codex on 2026-10-14 (it stays on the API).
  {
    providerId: 'codex',
    modelId: 'gpt-6-astra',
    label: 'most capable',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-6-sol',
    label: 'everyday and complex coding',
    contextWindow: 1_050_000,
    default: true,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-6-luna',
    label: 'fast, focused tasks',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.6-sol',
    label: 'prior gen, complex work',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.6-terra',
    label: 'prior gen, balanced',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.6-luna',
    label: 'prior gen, fast',
    contextWindow: 1_050_000,
  },
  {
    providerId: 'codex',
    modelId: 'gpt-5.5',
    label: 'deprecated — retires 2026-10-14',
    contextWindow: 1_050_000,
    retiresOn: '2026-10-14',
  },
  // xAI Grok — direct API. baseUrl: https://api.x.ai/v1
  // No sampling `profile` on any of these rows, deliberately: whether Grok
  // accepts `temperature`, `top_p` and `seed` is unverified against a live
  // endpoint (xai-grok-provider open question 2), and `applySamplingDefaults`
  // would put a catalog profile's values on the wire on every turn. Add a
  // profile only once that probe passes.
  // Source: https://docs.x.ai/docs/models (re-verified 2026-09-28).
  {
    providerId: 'xai',
    modelId: 'grok-4.7',
    label: 'most capable',
    contextWindow: 500_000,
    default: true,
  },
  { providerId: 'xai', modelId: 'grok-4.6', label: 'prior gen', contextWindow: 500_000 },
  { providerId: 'xai', modelId: 'grok-4.5', label: 'prior gen', contextWindow: 500_000 },
  {
    providerId: 'xai',
    modelId: 'grok-4.3',
    label: 'long context, cheaper',
    contextWindow: 1_000_000,
  },
  {
    providerId: 'xai',
    modelId: 'grok-build-0.1',
    label: 'code-specialized',
    contextWindow: 256_000,
  },
];

/**
 * Lane 0 — provider-level window defaults for runtimes whose model set is
 * operator-defined. vLLM serves whatever `--max-model-len` the operator set at
 * launch, so there is no honest per-model catalog row — the probe reads the
 * real `max_model_len` from `GET /v1/models`, and this default is only the
 * conservative fallback when both the probe and explicit config are silent.
 * (32,768 = ARCH_WINDOW_CAP_TOKENS — already at the local architecture cap,
 * so the cap never has to fire on it.)
 */
export const PROVIDER_WINDOW_DEFAULTS: Record<string, number> = {
  vllm: 32_768,
};

/**
 * True once `now` (UTC calendar day) has reached the row's `retiresOn`. A row
 * without `retiresOn` is never retired. `YYYY-MM-DD` strings compare
 * lexicographically, so the check is a string comparison.
 */
export function isModelRetired(entry: { retiresOn?: string }, now: Date = new Date()): boolean {
  if (entry.retiresOn === undefined) return false;
  return now.toISOString().slice(0, 10) >= entry.retiresOn;
}

/**
 * The rows a picker or catalog listing may show: every row whose retirement
 * date has not been reached. Evaluated per call, so a long-running process
 * hides a model on its retirement day without a restart. Lookups never go
 * through this — a config naming a hidden model still resolves.
 */
export function listedModels<T extends { retiresOn?: string }>(
  entries: readonly T[],
  now: Date = new Date(),
): T[] {
  return entries.filter((m) => !isModelRetired(m, now));
}

/** The listed (not yet retired) rows for one provider — what pickers show. */
export function getModelsForProvider(
  providerId: string,
  now: Date = new Date(),
): ModelCatalogEntry[] {
  return listedModels(
    MODEL_CATALOG.filter((m) => m.providerId === providerId),
    now,
  );
}

/**
 * Look up the context window for a `(providerId, modelId)` pair. Returns
 * `undefined` on a miss so callers can fall back to the provider default rather
 * than crash. Shared by the model picker and the provider factories so the
 * lookup lives in exactly one place (M1b).
 */
export function lookupContextWindow(providerId: string, modelId: string): number | undefined {
  return MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId)
    ?.contextWindow;
}

/**
 * The catalog's `label` and `contextWindow` for a `(providerId, modelId)` pair,
 * or `undefined` on a miss — the `CatalogModelLookup` `@ethosagent/config`'s
 * chain-model importer (`planChainModelImport`) takes, so the importer prefills
 * a registry entry from the same catalog every other surface reads. The catalog
 * carries no cost, so none is returned.
 */
export function lookupCatalogModel(
  providerId: string,
  modelId: string,
): { label: string; contextWindow: number } | undefined {
  const entry = MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId);
  return entry ? { label: entry.label, contextWindow: entry.contextWindow } : undefined;
}

/**
 * D11c — the catalog `modelId` a legacy personality declaration names, on ANY
 * provider, or `undefined`. Injected into `ModelResolutionContext.catalogModelId`
 * by `build-agent-loop.ts` and `tier-diagnostics.ts`, and read only by the
 * family rows of `mapLegacyModelDeclaration` (`packages/core/src/model-resolution.ts`).
 *
 * An exact id wins. Otherwise an UNDATED vendor alias names its dated snapshot —
 * `claude-sonnet-4-5` is how Anthropic addresses `claude-sonnet-4-5-20250929`,
 * which is the only form this catalog carries — so an id followed by exactly
 * `-YYYYMMDD` counts. Nothing looser: a near-miss is a typo, and the shim must
 * not guess about one. Bundled catalog only, the same one `lookupContextWindow`
 * reads. Deleted with the shim at `0.10.0`.
 */
export function lookupLegacyCatalogModelId(declared: string): string | undefined {
  const exact = MODEL_CATALOG.find((m) => m.modelId === declared);
  if (exact) return exact.modelId;
  const dated = MODEL_CATALOG.find(
    (m) =>
      m.modelId.startsWith(`${declared}-`) && /^\d{8}$/.test(m.modelId.slice(declared.length + 1)),
  );
  return dated?.modelId;
}

/**
 * Look up the per-model `profile` for a `(providerId, modelId)` pair. Same
 * lookup shape as {@link lookupContextWindow} (DRY). Returns `undefined` on a
 * miss OR when the entry carries no profile — callers then apply no defaults.
 */
export function lookupProfile(providerId: string, modelId: string): ModelProfile | undefined {
  return MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId)?.profile;
}

/**
 * Merge a config `models:` override OVER a catalog `profile`. The override wins
 * field-by-field (per-key for sampling). Precedence within §7: config override
 * beats catalog. Returns `undefined` when neither side sets anything.
 */
export function mergeModelProfile(
  base: ModelProfile | undefined,
  override: ModelProfile | undefined,
): ModelProfile | undefined {
  if (!base && !override) return undefined;
  const merged: ModelProfile = {};
  const sampling = { ...base?.sampling, ...override?.sampling };
  if (Object.keys(sampling).length > 0) merged.sampling = sampling;
  const toolCallFormat = override?.toolCallFormat ?? base?.toolCallFormat;
  if (toolCallFormat !== undefined) merged.toolCallFormat = toolCallFormat;
  const maxOutputTokens = override?.maxOutputTokens ?? base?.maxOutputTokens;
  if (maxOutputTokens !== undefined) merged.maxOutputTokens = maxOutputTokens;
  const structuredOutput = override?.structuredOutput ?? base?.structuredOutput;
  if (structuredOutput !== undefined) merged.structuredOutput = structuredOutput;
  const parseThinkTags = override?.parseThinkTags ?? base?.parseThinkTags;
  if (parseThinkTags !== undefined) merged.parseThinkTags = parseThinkTags;
  // §5 — merge compaction per-field (override wins per key) so a partial
  // override (e.g. only `pressure`) keeps the base `target`.
  const compaction = { ...base?.compaction, ...override?.compaction };
  if (Object.keys(compaction).length > 0) merged.compaction = compaction;
  const charsPerToken = override?.charsPerToken ?? base?.charsPerToken;
  if (charsPerToken !== undefined) merged.charsPerToken = charsPerToken;
  // §2 — merge promptBudget per-field (override wins per key) so a partial
  // override keeps the base's other knobs.
  const promptBudget = { ...base?.promptBudget, ...override?.promptBudget };
  if (Object.keys(promptBudget).length > 0) merged.promptBudget = promptBudget;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * §5 — resolve the effective compaction gate config for a model. Precedence:
 * per-model `profile.compaction` > global `compaction:` config > the gate's
 * hardcoded 0.8/0.7 defaults (applied downstream in the gate, so both-absent
 * yields `undefined` here and the gate stays byte-identical to today).
 * `charsPerToken` is per-model only. Returns `undefined` when nothing is set.
 */
export function resolveCompactionGate(
  profile: ModelProfile | undefined,
  global: { pressure?: number; target?: number } | undefined,
): { pressure?: number; target?: number; charsPerToken?: number } | undefined {
  const pressure = profile?.compaction?.pressure ?? global?.pressure;
  const target = profile?.compaction?.target ?? global?.target;
  const charsPerToken = profile?.charsPerToken;
  if (pressure === undefined && target === undefined && charsPerToken === undefined) {
    return undefined;
  }
  return {
    ...(pressure !== undefined ? { pressure } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(charsPerToken !== undefined ? { charsPerToken } : {}),
  };
}

/**
 * Window (tokens) at or above which a model counts as "frontier" for the
 * purpose of picking a default context engine. Below it — mid / small / local —
 * we never DEFAULT to LLM self-summarization; deterministic `drop_oldest` (plus
 * the always-on Phase 1 tool-result aging) carries the load instead.
 */
export const FRONTIER_WINDOW_TOKENS = 128_000;

/**
 * Phase 3 — per-model-class default context engine, used only when the
 * personality declares no `context_engine`. Frontier models with a wired
 * summarizer (`auxiliary.compression.model`) default to `semantic_summary`;
 * everything else — mid, small, and local models — defaults to `drop_oldest`.
 * This keeps weak/local models on deterministic reductions.
 */
export function resolveDefaultContextEngine(
  contextWindow: number | undefined,
  summarizerWired: boolean,
): 'semantic_summary' | 'drop_oldest' {
  const window = contextWindow ?? 0;
  if (summarizerWired && window >= FRONTIER_WINDOW_TOKENS) return 'semantic_summary';
  return 'drop_oldest';
}

/**
 * Phase 4 — a model at or below this window always enters small-window mode.
 * Below ~32k the fixed prompt overhead (SOUL + tools) leaves too little room
 * for history; the mode swaps to index-not-content memory, a compact prelude,
 * forced-index skills, and a scaled history limit.
 */
export const SMALL_WINDOW_MAX_TOKENS = 32_000;

/**
 * Phase 4 — ratio trigger. On a LARGER window, small-window mode still activates
 * when the measured static sections (system + tools) exceed this fraction of the
 * window — the "big SOUL / big toolset on a mid model" case a fixed 32k cutoff
 * would miss.
 */
export const SMALL_WINDOW_STATIC_RATIO = 0.4;

/**
 * Phase 4 — decide whether small-window mode is active. Pure and static-input
 * only (window + measured static overhead), so the decision is resolved ONCE per
 * loop and never varies per turn — the prompt prefix stays byte-stable.
 * `override` from config forces the mode on/off; `auto` (default) applies the
 * window + ratio triggers.
 */
export function resolveSmallWindowMode(opts: {
  contextWindow: number | undefined;
  staticTokens: number;
  override?: 'auto' | 'on' | 'off';
}): boolean {
  if (opts.override === 'on') return true;
  if (opts.override === 'off') return false;
  const window = opts.contextWindow ?? 0;
  if (window <= 0) return false;
  if (window <= SMALL_WINDOW_MAX_TOKENS) return true;
  return opts.staticTokens / window > SMALL_WINDOW_STATIC_RATIO;
}

/**
 * Phase 4 — scale the history message limit to the window. Frontier windows keep
 * the default 200; smaller windows get proportionally fewer messages
 * (~1 per 400 tokens), clamped to [40, 200] so a tiny window still keeps a
 * usable recent tail.
 */
export function scaleHistoryLimit(contextWindow: number | undefined): number {
  const window = contextWindow ?? 0;
  if (window <= 0 || window >= FRONTIER_WINDOW_TOKENS) return 200;
  return Math.min(200, Math.max(40, Math.round(window / 400)));
}

export function getDefaultModel(
  providerId: string,
  now: Date = new Date(),
): ModelCatalogEntry | undefined {
  const models = getModelsForProvider(providerId, now);
  return models.find((m) => m.default) ?? models[0];
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M ctx`;
  return `${Math.round(tokens / 1_000)}k ctx`;
}
