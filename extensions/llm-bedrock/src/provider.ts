import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';
import type { SigV4Config } from './sigv4';
import { streamBedrockConverse } from './transport';

export interface BedrockProviderConfig {
  region: string;
  modelId: string;
  sigv4: SigV4Config;
  /** UBP-030 — retries of a transient failure before the first byte. Absent → 2;
   *  wiring passes 0 for a hop in a chain of two or more (failover is the retry). */
  maxRetries?: number;
}

export class BedrockProvider implements LLMProvider {
  readonly name = 'bedrock';
  readonly model: string;
  readonly maxContextTokens = 200_000;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly supportsVision = { images: true, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  private readonly config: BedrockProviderConfig;

  constructor(config: BedrockProviderConfig) {
    this.config = config;
    this.model = config.modelId;
  }

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      visionImages: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'top-level',
      tokenCounting: 'estimated',
      contractVersion: 1,
    };
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    yield* streamBedrockConverse(
      {
        region: this.config.region,
        sigv4: this.config.sigv4,
        modelId: this.model,
        ...(this.config.maxRetries !== undefined
          ? { retry: { maxRetries: this.config.maxRetries } }
          : {}),
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
