import type { CompletionChunk, LLMProvider } from '@ethosagent/types';

export interface Call {
  name: string;
  input: Record<string, unknown>;
}

/** Scripted LLM: every call in one response, then a plain end_turn. */
export function scriptedLLM(calls: Call[]): LLMProvider {
  let n = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      n++;
      if (n > 1) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const [i, c] of calls.entries()) {
        const id = `call-${i}`;
        const json = JSON.stringify(c.input);
        yield { type: 'tool_use_start', toolCallId: id, toolName: c.name };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: json };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: json };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}
