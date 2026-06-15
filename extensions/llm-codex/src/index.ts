import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { toResponsesInput, toResponsesTools } from './responses-adapter';
import { type ResponsesApiBody, streamResponsesApi } from './transport';

export type { CodexCredentials } from './auth';
export {
  ensureValidToken,
  exchangeForTokens,
  loadTokens,
  pollForAuthorization,
  requestDeviceCode,
  saveTokens,
} from './auth';
export { CODEX_FALLBACK_MODELS } from './models';
export { type ResponsesApiBody, streamResponsesApi } from './transport';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CodexProviderConfig {
  model: string;
  getAccessToken: () => Promise<string>;
  maxContextTokens?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

// ---------------------------------------------------------------------------
// CodexProvider
// ---------------------------------------------------------------------------

export class CodexProvider implements LLMProvider {
  readonly name = 'codex';
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly supportsVision = { images: false, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  private readonly getAccessToken: () => Promise<string>;

  constructor(config: CodexProviderConfig) {
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 200_000;
    this.getAccessToken = config.getAccessToken;
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const token = await this.getAccessToken();
    const effectiveModel = options.modelOverride ?? this.model;

    const body: ResponsesApiBody = {
      model: effectiveModel,
      input: toResponsesInput(messages),
      stream: true,
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };

    if (options.system) {
      body.instructions = options.system;
    }

    const responsesTools = toResponsesTools(tools);
    if (responsesTools.length > 0) {
      body.tools = responsesTools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    // The Codex Responses API rejects `max_output_tokens` with a 400
    // ("Unsupported parameter") — output length is managed server-side, so
    // `options.maxTokens` is intentionally not forwarded.

    // Per-slice token estimate (best-effort, mirrors other providers).
    let requestTokens: { system: number; tools: number; messages: number } | undefined;
    try {
      const systemText = options.system ?? '';
      const toolsText = responsesTools.length > 0 ? JSON.stringify(responsesTools) : '';
      requestTokens = {
        system: Math.ceil(systemText.length / 4),
        tools: Math.ceil(toolsText.length / 4),
        messages: await this.countTokens(messages),
      };
    } catch {
      // Best-effort: if counting fails, requestTokens stays undefined.
    }

    yield* streamResponsesApi(RESPONSES_ENDPOINT, token, body, options.abortSignal, requestTokens);
  }

  async countTokens(messages: Message[]): Promise<number> {
    // No token-counting API available — rough character-based estimate.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }
}
