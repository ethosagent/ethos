import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  Tool,
  ToolDefinitionLite,
  ToolResult,
} from '@ethosagent/types';

export interface Step {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  finishReason?: 'end_turn' | 'tool_use';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    estimatedCostUsd?: number;
  };
  thinking?: string;
  throwError?: string;
  hangMs?: number;
}

export interface CapturedCall {
  messages: Message[];
  options: CompletionOptions;
}

export function makeScriptedLLM(steps: Step[], captured: CapturedCall[] = []): LLMProvider {
  let i = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      _tools: ToolDefinitionLite[],
      opts: CompletionOptions,
    ): AsyncGenerator<CompletionChunk> {
      captured.push({
        messages: JSON.parse(JSON.stringify(messages)),
        options: { ...opts, abortSignal: undefined },
      });
      const step = steps[i++] ?? { finishReason: 'end_turn' as const };

      if (step.throwError) throw new Error(step.throwError);
      if (step.hangMs) {
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          }, step.hangMs);
          opts.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      }

      if (step.thinking) yield { type: 'thinking_delta', thinking: step.thinking };
      if (step.text) yield { type: 'text_delta', text: step.text };
      for (const tc of step.toolCalls ?? []) {
        yield { type: 'tool_use_start', toolCallId: tc.id, toolName: tc.name };
        yield {
          type: 'tool_use_delta',
          toolCallId: tc.id,
          partialJson: JSON.stringify(tc.input),
        };
        yield {
          type: 'tool_use_end',
          toolCallId: tc.id,
          inputJson: JSON.stringify(tc.input),
        };
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: step.usage?.inputTokens ?? 1,
          outputTokens: step.usage?.outputTokens ?? 1,
          cacheReadTokens: step.usage?.cacheReadTokens ?? 0,
          cacheCreationTokens: step.usage?.cacheCreationTokens ?? 0,
          estimatedCostUsd: step.usage?.estimatedCostUsd ?? 0,
        },
      };
      yield { type: 'done', finishReason: step.finishReason ?? 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

export function makeTool(name: string, value: string, opts?: { returnDirect?: boolean }): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: { type: 'object' },
    capabilities: {},
    ...(opts?.returnDirect ? { returnDirect: true } : {}),
    async execute(): Promise<ToolResult> {
      return { ok: true, value };
    },
  };
}

export function makeUntrustedTool(name: string, value: string): Tool {
  return {
    name,
    description: `${name} returns external content`,
    schema: { type: 'object' },
    capabilities: {},
    outputIsUntrusted: true,
    async execute(): Promise<ToolResult> {
      return { ok: true, value };
    },
  };
}

export function makeFailingTool(name: string, error: string): Tool {
  return {
    name,
    description: `${name} fails`,
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: false, error, code: 'execution_failed' };
    },
  };
}
