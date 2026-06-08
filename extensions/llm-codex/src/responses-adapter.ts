import type { Message, MessageContent, ToolDefinitionLite } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Ethos Message[] → Responses API input format
// ---------------------------------------------------------------------------

/**
 * Convert an Ethos MessageContent block into one or more Responses API input
 * items. Most blocks map 1:1; an assistant message with mixed text + tool_use
 * blocks is split into separate items (the Responses API uses flat item lists,
 * not nested content arrays).
 */
function contentBlockToItems(block: MessageContent, role: 'user' | 'assistant'): unknown[] {
  switch (block.type) {
    case 'text':
      return [{ role, content: block.text }];

    case 'tool_use':
      return [
        {
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        },
      ];

    case 'tool_result':
      if (!block.tool_use_id) return [];
      return [
        {
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        },
      ];

    case 'image':
      // Responses API does not have a native image block — send as a data URI
      // inside a user text message so the model still receives it.
      return [
        {
          role: 'user',
          content: `[image: data:${block.mediaType};base64,${block.data}]`,
        },
      ];

    case 'document':
      return [
        {
          role: 'user',
          content: `[document: data:${block.mediaType};base64,${block.data}]`,
        },
      ];

    default: {
      const _exhaustive: never = block;
      throw new Error(`unhandled MessageContent type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Convert Ethos Message[] into the Responses API `input` array.
 *
 * The Responses API uses a flat list of items:
 * - `{ role: 'user', content: '...' }`
 * - `{ role: 'assistant', content: '...' }`
 * - `{ type: 'function_call', call_id, name, arguments }`
 * - `{ type: 'function_call_output', call_id, output }`
 */
export function toResponsesInput(messages: Message[]): unknown[] {
  const items: unknown[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      items.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Collect text blocks for the current role; tool blocks become separate items.
    const textParts: string[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else {
        // Flush accumulated text before emitting a non-text item.
        if (textParts.length > 0) {
          items.push({ role: msg.role, content: textParts.join('\n') });
          textParts.length = 0;
        }
        items.push(...contentBlockToItems(block, msg.role));
      }
    }

    // Flush remaining text.
    if (textParts.length > 0) {
      items.push({ role: msg.role, content: textParts.join('\n') });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Ethos ToolDefinitionLite[] → Responses API tools format
// ---------------------------------------------------------------------------

/**
 * Convert Ethos tool definitions to the Responses API tool format.
 *
 * The Responses API uses:
 * `{ type: 'function', name, description, parameters }`
 */
export function toResponsesTools(tools: ToolDefinitionLite[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}
