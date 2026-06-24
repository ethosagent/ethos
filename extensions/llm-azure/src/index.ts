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

  constructor(config: AzureOpenAIProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      apiVersion: config.apiVersion,
    });
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const params = await buildChatCompletionsParamsAsync(messages, tools, options, this.model, {
      countTokens: (msgs) => this.countTokens(msgs),
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

export const PROVIDER_CONTRACT_MAJOR = 2;
export const AZURE_DEFAULT_API_VERSION = '2024-12-01-preview';

export const azureFactory: LLMProviderFactory = async ({ config: cfg, secrets }) => {
  if (!cfg.baseUrl) {
    throw new Error(
      'Azure provider requires `baseUrl` set to the resource endpoint ' +
        '(e.g. https://my-resource.openai.azure.com).',
    );
  }
  const apiKey = (await secrets.get('providers/azure/apiKey')) ?? (cfg.apiKey as string);
  return new AzureOpenAIProvider({
    name: 'azure',
    model: cfg.model as string,
    apiKey,
    endpoint: cfg.baseUrl as string,
    apiVersion: (cfg.apiVersion as string) ?? AZURE_DEFAULT_API_VERSION,
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('azure', azureFactory);
}
