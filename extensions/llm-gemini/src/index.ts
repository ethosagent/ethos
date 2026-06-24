import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { type GeminiTransportConfig, streamGeminiGenerate } from './transport';

export type { GeminiTransportConfig };

export interface GeminiNativeProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class GeminiNativeProvider implements LLMProvider {
  readonly name = 'gemini-native';
  readonly model: string;
  readonly maxContextTokens = 1_000_000;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly supportsVision = { images: true, documents: true };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  private readonly config: GeminiNativeProviderConfig;

  constructor(config: GeminiNativeProviderConfig) {
    this.config = config;
    this.model = config.model;
  }

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: true,
      visionDocuments: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'top-level',
      tokenCounting: 'estimated',
      maxInputTokens: 1_000_000,
      contractVersion: 1,
    };
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    yield* streamGeminiGenerate(
      {
        apiKey: this.config.apiKey,
        model: this.model,
        baseUrl: this.config.baseUrl,
      },
      messages,
      tools,
      options,
      options.abortSignal,
    );
  }

  async countTokens(_messages: Message[]): Promise<number> {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// First-party plugin activation
// ---------------------------------------------------------------------------

import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';

export const PROVIDER_CONTRACT_MAJOR = 3;

export const geminiNativeFactory: LLMProviderFactory = async ({ config: cfg, secrets, logger }) => {
  const secretKey = await secrets.get('providers/gemini-native/apiKey');
  const apiKey = secretKey ?? (cfg.apiKey as string);
  if (secretKey === null && cfg.apiKey) {
    logger.warn(
      'Using plaintext apiKey from config for gemini-native; migrate to the secret store: ethos secrets set providers/gemini-native/apiKey <key>',
    );
  }
  if (!apiKey) {
    throw new Error('Gemini native provider requires an API key');
  }
  return new GeminiNativeProvider({
    apiKey,
    model: cfg.model as string,
    baseUrl: cfg.baseUrl as string | undefined,
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('gemini-native', geminiNativeFactory);
}
