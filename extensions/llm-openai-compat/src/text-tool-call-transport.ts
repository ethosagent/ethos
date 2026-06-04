import type { CompletionChunk } from '@ethosagent/types';

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

/** Maximum buffered bytes inside a single tool_call block before treating it
 *  as malformed and degrading to plain text output. */
const MAX_TOOL_CALL_SIZE = 64_000;

export async function* streamTextToolCalls(
  upstream: AsyncIterable<CompletionChunk>,
): AsyncIterable<CompletionChunk> {
  let buffer = '';
  let insideToolCall = false;
  let toolCallCounter = 0;
  let hasToolCalls = false;
  let heldDone: CompletionChunk | null = null;

  for await (const chunk of upstream) {
    if (chunk.type === 'done') {
      // Hold done — we'll emit it after flushing the buffer
      heldDone = hasToolCalls ? { ...chunk, finishReason: 'tool_use' } : chunk;
      continue;
    }

    if (chunk.type !== 'text_delta') {
      yield chunk;
      continue;
    }

    buffer += chunk.text;

    while (buffer.length > 0) {
      if (!insideToolCall) {
        const openIdx = buffer.indexOf(OPEN_TAG);
        if (openIdx === -1) {
          // No tag found — emit buffer as text, keeping a safety window
          // for partial '<tool_call>' at the end
          const safeLen = buffer.length - OPEN_TAG.length;
          if (safeLen > 0) {
            yield { type: 'text_delta', text: buffer.slice(0, safeLen) };
            buffer = buffer.slice(safeLen);
          }
          break;
        }
        // Emit text before the tag
        if (openIdx > 0) {
          yield { type: 'text_delta', text: buffer.slice(0, openIdx) };
        }
        buffer = buffer.slice(openIdx + OPEN_TAG.length);
        insideToolCall = true;
      }

      if (insideToolCall) {
        // Guard: if the buffer exceeds the size limit, treat as malformed
        if (buffer.length > MAX_TOOL_CALL_SIZE) {
          yield { type: 'text_delta', text: `${OPEN_TAG}${buffer}` };
          buffer = '';
          insideToolCall = false;
          continue;
        }

        const closeIdx = buffer.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          // Haven't seen close tag yet — wait for more data
          break;
        }

        const toolCallContent = buffer.slice(0, closeIdx).trim();
        buffer = buffer.slice(closeIdx + CLOSE_TAG.length);
        insideToolCall = false;

        try {
          const parsed = JSON.parse(toolCallContent);
          const name = (parsed.name as string) ?? '';
          const args: unknown = parsed.arguments ?? {};
          const argsStr = JSON.stringify(args);
          const toolCallId = `text-tool-${toolCallCounter++}`;
          hasToolCalls = true;

          yield { type: 'tool_use_start', toolCallId, toolName: name };
          yield { type: 'tool_use_delta', toolCallId, partialJson: argsStr };
          yield { type: 'tool_use_end', toolCallId, inputJson: argsStr };
        } catch {
          // Malformed JSON — emit as text
          yield { type: 'text_delta', text: `${OPEN_TAG}${toolCallContent}${CLOSE_TAG}` };
        }
      }
    }
  }

  // Flush remaining buffer (before done)
  if (buffer.length > 0) {
    if (insideToolCall) {
      // Unclosed tool_call — emit as text (graceful degradation)
      yield { type: 'text_delta', text: `${OPEN_TAG}${buffer}` };
    } else {
      yield { type: 'text_delta', text: buffer };
    }
  }

  // Emit held done event after buffer flush
  if (heldDone) {
    yield heldDone;
  }
}
