import {
  buildChatCompletionsParamsAsync,
  streamChatCompletions,
} from '@ethosagent/llm-openai-compat';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { AzureOpenAI } from 'openai';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AzureOpenAIProviderConfig {
  /** Stable identifier surfaced to users (catalog id, observability). */
  name: string;
  /** Azure deployment name — what Ethos calls `model`. The SDK maps this
   *  to `/openai/deployments/<deployment>/...`. */
  model: string;
  /** Azure API key (the `api-key` header value). */
  apiKey: string;
  /** Resource endpoint, e.g. `https://my-resource.openai.azure.com`.
   *  The SDK appends `/openai/deployments/<deployment>/...`. */
  endpoint: string;
  /** Azure REST API version, e.g. `2024-10-21`. Pin to a stable version;
   *  preview versions change behavior between releases. */
  apiVersion: string;
  maxContextTokens?: number;
  /** SDK retry count. Wiring sets `0` on a hop in a provider chain so failover
   *  is not delayed by `retry-after`-honouring retries. Absent → SDK default. */
  maxRetries?: number;
  /**
   * V-CP-5 / UBP-038 — force the output-cap parameter (`providers.<n>.outputCapParam`).
   * Absent → the model-id rule applied to the deployment name (`outputCapParam`
   * in @ethosagent/llm-openai-compat), which sends `max_tokens` to a reasoning
   * deployment whose name is not a reasoning model id; such a deployment needs
   * `max_completion_tokens` here. Pinned by `__tests__/output-cap-param.test.ts`.
   */
  outputCapParam?: 'max_tokens' | 'max_completion_tokens';
}

// ---------------------------------------------------------------------------
// AzureOpenAIProvider
// ---------------------------------------------------------------------------
//
// Azure OpenAI is wire-compatible with the OpenAI Chat Completions API but
// differs in two places that prevent reusing `OpenAICompatProvider` directly:
//
//   1. Auth: Azure uses the `api-key` header instead of `Authorization: Bearer`.
//   2. Routing: every request needs an `api-version` query param and is
//      addressed by deployment name, not by model id.
//
// The `AzureOpenAI` client (shipped inside the same `openai` package) handles
// both transparently. The streaming + tool-call translation logic is shared
// via `buildChatCompletionsParamsAsync` and `streamChatCompletions` from the
// sibling llm-openai-compat extension.

export class AzureOpenAIProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly supportsVision = { images: true, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'system-role',
      tokenCounting: 'estimated',
      contractVersion: 1,
    };
  }

  private readonly client: AzureOpenAI;
  private readonly outputCapParam: AzureOpenAIProviderConfig['outputCapParam'];

  constructor(config: AzureOpenAIProviderConfig) {
    this.name = config.name;
    this.outputCapParam = config.outputCapParam;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      apiVersion: config.apiVersion,
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    });
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const params = await buildChatCompletionsParamsAsync(messages, tools, options, this.model, {
      countTokens: (msgs) => this.countTokens(msgs),
      ...(this.outputCapParam !== undefined ? { outputCapParam: this.outputCapParam } : {}),
    });
    yield* streamChatCompletions(this.client, params, options.abortSignal);
  }

  async countTokens(messages: Message[]): Promise<number> {
    // Azure doesn't expose a token-count endpoint either; same ~4 chars/token
    // approximation as OpenAICompatProvider.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }
}

// ---------------------------------------------------------------------------
// First-party plugin activation (§9.2 — dogfooding the plugin SDK)
// ---------------------------------------------------------------------------

import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';

export const PROVIDER_CONTRACT_MAJOR = 3;
export const AZURE_DEFAULT_API_VERSION = '2024-12-01-preview';

export const azureFactory: LLMProviderFactory = async ({ config: cfg, secrets, logger }) => {
  if (!cfg.baseUrl) {
    throw new Error(
      'Azure provider requires `baseUrl` set to the resource endpoint ' +
        '(e.g. https://my-resource.openai.azure.com).',
    );
  }
  const outputCapParam = cfg.outputCapParam;
  if (
    outputCapParam !== undefined &&
    outputCapParam !== 'max_tokens' &&
    outputCapParam !== 'max_completion_tokens'
  ) {
    throw new Error(
      `Azure provider \`outputCapParam\` must be max_tokens or max_completion_tokens, ` +
        `not ${JSON.stringify(outputCapParam)}.`,
    );
  }
  const secretKey = await secrets.get('providers/azure/apiKey');
  const apiKey = secretKey ?? (cfg.apiKey as string);
  if (secretKey === null && cfg.apiKey) {
    logger.warn(
      'Using plaintext apiKey from config for azure; migrate to the secret store: ethos secrets set providers/azure/apiKey <key>',
    );
  }
  return new AzureOpenAIProvider({
    name: 'azure',
    model: cfg.model as string,
    apiKey,
    endpoint: cfg.baseUrl as string,
    apiVersion: (cfg.apiVersion as string) ?? AZURE_DEFAULT_API_VERSION,
    ...(typeof cfg.maxRetries === 'number' ? { maxRetries: cfg.maxRetries } : {}),
    ...(outputCapParam !== undefined ? { outputCapParam } : {}),
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('azure', azureFactory);
}
