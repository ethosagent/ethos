import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';
import {
  createGeminiStreamState,
  type GeminiStreamState,
  type GeminiTransportConfig,
  streamGeminiGenerate,
} from './transport';

export { buildGeminiBody, createGeminiStreamState, streamGeminiGenerate } from './transport';
export type { GeminiStreamState, GeminiTransportConfig };

export interface GeminiNativeProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** UBP-030 — retries of a transient failure before the first byte. Absent → 2;
   *  wiring passes 0 for a hop in a chain of two or more (failover is the retry). */
  maxRetries?: number;
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
  /** UBP-031/032 — tool-call id minting and remembered thought signatures,
   *  kept for the provider's lifetime (see `GeminiStreamState`). */
  private readonly streamState: GeminiStreamState = createGeminiStreamState();

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
        ...(this.config.maxRetries !== undefined
          ? { retry: { maxRetries: this.config.maxRetries } }
          : {}),
      },
      messages,
      tools,
      options,
      options.abortSignal,
      this.streamState,
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
    ...(typeof cfg.maxRetries === 'number' ? { maxRetries: cfg.maxRetries } : {}),
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('gemini-native', geminiNativeFactory);
}
