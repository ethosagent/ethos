import type { AgentEvent, CompletionChunk } from '@ethosagent/types';

export function* handleChunk(
  chunk: CompletionChunk,
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    partialJson: string;
    args?: unknown;
  }>,
  onText: (t: string) => void,
): Generator<AgentEvent> {
  switch (chunk.type) {
    case 'text_delta':
      onText(chunk.text);
      yield { type: 'text_delta', text: chunk.text };
      break;

    case 'thinking_delta':
      yield { type: 'thinking_delta', thinking: chunk.thinking };
      break;

    case 'tool_use_start':
      pendingToolCalls.push({
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        partialJson: '',
      });
      break;

    case 'tool_use_delta': {
      const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
      if (tc) tc.partialJson += chunk.partialJson;
      break;
    }

    case 'tool_use_end': {
      const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
      if (tc) {
        try {
          tc.args = JSON.parse(chunk.inputJson || tc.partialJson);
        } catch {
          tc.args = {};
        }
      }
      break;
    }

    case 'usage':
      yield {
        type: 'usage',
        inputTokens: chunk.usage.inputTokens,
        outputTokens: chunk.usage.outputTokens,
        estimatedCostUsd: chunk.usage.estimatedCostUsd,
      };
      break;

    case 'done':
      // finishReason available here for future context-compaction (Phase 3)
      break;
  }
}
