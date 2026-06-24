import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';

export interface MyProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class MyProvider implements LLMProvider {
  readonly name = 'my-provider';
  readonly model: string;
  readonly maxContextTokens = 128_000;
  readonly supportsCaching = false;
  readonly supportsThinking = false;

  protected readonly config: MyProviderConfig;

  constructor(config: MyProviderConfig) {
    this.config = config;
    this.model = config.model;
  }

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'system-role',
      tokenCounting: 'estimated',
      contractVersion: 1,
    };
  }

  async *complete(
    _messages: Message[],
    _tools: ToolDefinitionLite[],
    _options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    // TODO: Replace with your provider's API call
    // 1. Convert messages/tools/options to your provider's wire format
    // 2. Make the streaming API call
    // 3. Parse the response stream and yield CompletionChunk variants:
    //    - { type: 'text_delta', text: '...' }
    //    - { type: 'tool_use_start', toolCallId: '...', toolName: '...' }
    //    - { type: 'tool_use_delta', toolCallId: '...', partialJson: '...' }
    //    - { type: 'tool_use_end', toolCallId: '...', inputJson: '...' }
    //    - { type: 'usage', usage: { inputTokens, outputTokens, ... } }
    //    - { type: 'warning', message: '...' } // for dropped params
    //    - { type: 'done', finishReason: 'end_turn' | 'tool_use' | 'max_tokens' }

    yield { type: 'text_delta', text: 'Hello from MyProvider!' };
    yield {
      type: 'usage',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
      },
    };
    yield { type: 'done', finishReason: 'end_turn' };
  }

  async countTokens(_messages: Message[]): Promise<number> {
    return 0;
  }
}
