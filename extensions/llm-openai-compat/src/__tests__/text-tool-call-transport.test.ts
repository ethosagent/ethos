import type { CompletionChunk } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { streamTextToolCalls } from '../text-tool-call-transport';

async function* makeChunks(...chunks: CompletionChunk[]): AsyncIterable<CompletionChunk> {
  for (const c of chunks) yield c;
}

async function collect(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const result: CompletionChunk[] = [];
  for await (const c of stream) result.push(c);
  return result;
}

/** findLastIndex polyfill for ES2022 targets. */
function lastIndexOf(arr: CompletionChunk[], predicate: (c: CompletionChunk) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item && predicate(item)) return i;
  }
  return -1;
}

describe('streamTextToolCalls', () => {
  it('parses a single tool_call block into tool_use events', async () => {
    const xml =
      '<tool_call>\n{"name": "read_file", "arguments": {"path": "/tmp/foo"}}\n</tool_call>';
    const chunks = await collect(
      streamTextToolCalls(makeChunks({ type: 'text_delta', text: xml })),
    );

    const start = chunks.find((c) => c.type === 'tool_use_start');
    expect(start).toBeDefined();
    expect(start).toMatchObject({
      type: 'tool_use_start',
      toolCallId: 'text-tool-0',
      toolName: 'read_file',
    });

    const delta = chunks.find((c) => c.type === 'tool_use_delta');
    expect(delta).toBeDefined();
    expect(delta).toMatchObject({
      type: 'tool_use_delta',
      toolCallId: 'text-tool-0',
      partialJson: '{"path":"/tmp/foo"}',
    });

    const end = chunks.find((c) => c.type === 'tool_use_end');
    expect(end).toBeDefined();
    expect(end).toMatchObject({
      type: 'tool_use_end',
      toolCallId: 'text-tool-0',
      inputJson: '{"path":"/tmp/foo"}',
    });
  });

  it('handles parallel tool calls with distinct IDs', async () => {
    const xml =
      '<tool_call>{"name": "read_file", "arguments": {"path": "/a"}}</tool_call>' +
      '<tool_call>{"name": "write_file", "arguments": {"path": "/b"}}</tool_call>';
    const chunks = await collect(
      streamTextToolCalls(makeChunks({ type: 'text_delta', text: xml })),
    );

    const starts = chunks.filter((c) => c.type === 'tool_use_start') as Array<
      Extract<CompletionChunk, { type: 'tool_use_start' }>
    >;
    expect(starts).toHaveLength(2);
    expect(starts[0].toolCallId).toBe('text-tool-0');
    expect(starts[0].toolName).toBe('read_file');
    expect(starts[1].toolCallId).toBe('text-tool-1');
    expect(starts[1].toolName).toBe('write_file');
  });

  it('preserves text around tool call blocks', async () => {
    const text = 'Hello world! <tool_call>{"name": "echo", "arguments": {}}</tool_call> Done.';
    const chunks = await collect(streamTextToolCalls(makeChunks({ type: 'text_delta', text })));

    const textChunks = chunks.filter((c) => c.type === 'text_delta') as Array<
      Extract<CompletionChunk, { type: 'text_delta' }>
    >;
    const allText = textChunks.map((c) => c.text).join('');
    expect(allText).toBe('Hello world!  Done.');

    expect(chunks.find((c) => c.type === 'tool_use_start')).toBeDefined();
  });

  it('emits unclosed tool_call as plain text (graceful degradation)', async () => {
    const chunks = await collect(
      streamTextToolCalls(
        makeChunks(
          { type: 'text_delta', text: '<tool_call>unclosed content' },
          { type: 'done', finishReason: 'end_turn' },
        ),
      ),
    );

    const textChunks = chunks.filter((c) => c.type === 'text_delta') as Array<
      Extract<CompletionChunk, { type: 'text_delta' }>
    >;
    const allText = textChunks.map((c) => c.text).join('');
    expect(allText).toBe('<tool_call>unclosed content');

    // done should NOT have finishReason adjusted since no tool calls were emitted
    const done = chunks.find((c) => c.type === 'done') as Extract<
      CompletionChunk,
      { type: 'done' }
    >;
    expect(done.finishReason).toBe('end_turn');
  });

  it('handles empty arguments', async () => {
    const xml = '<tool_call>{"name": "list_files", "arguments": {}}</tool_call>';
    const chunks = await collect(
      streamTextToolCalls(makeChunks({ type: 'text_delta', text: xml })),
    );

    const start = chunks.find((c) => c.type === 'tool_use_start') as Extract<
      CompletionChunk,
      { type: 'tool_use_start' }
    >;
    expect(start).toBeDefined();
    expect(start.toolName).toBe('list_files');
    expect(start.toolCallId).toBe('text-tool-0');

    const end = chunks.find((c) => c.type === 'tool_use_end') as Extract<
      CompletionChunk,
      { type: 'tool_use_end' }
    >;
    expect(end).toBeDefined();
    expect(end.inputJson).toBe('{}');
  });

  it('adjusts done finishReason to tool_use when tool calls were emitted', async () => {
    const chunks = await collect(
      streamTextToolCalls(
        makeChunks(
          { type: 'text_delta', text: '<tool_call>{"name": "echo", "arguments": {}}</tool_call>' },
          { type: 'done', finishReason: 'end_turn' },
        ),
      ),
    );

    const done = chunks.find((c) => c.type === 'done') as Extract<
      CompletionChunk,
      { type: 'done' }
    >;
    expect(done.finishReason).toBe('tool_use');
  });

  it('passes non-text_delta events through unchanged', async () => {
    const usage: CompletionChunk = {
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
      },
    };
    const chunks = await collect(streamTextToolCalls(makeChunks(usage)));
    expect(chunks).toEqual([usage]);
  });

  it('emits done AFTER remaining buffer text is flushed', async () => {
    const chunks = await collect(
      streamTextToolCalls(
        makeChunks(
          { type: 'text_delta', text: 'trailing text' },
          { type: 'done', finishReason: 'end_turn' },
        ),
      ),
    );

    // Find the indices of the last text_delta and the done event
    const lastTextIdx = lastIndexOf(chunks, (c) => c.type === 'text_delta');
    const doneIdx = chunks.findIndex((c) => c.type === 'done');
    expect(lastTextIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(lastTextIdx);
  });

  it('emits done AFTER unclosed tool_call buffer is flushed as text', async () => {
    const chunks = await collect(
      streamTextToolCalls(
        makeChunks(
          { type: 'text_delta', text: '<tool_call>partial content' },
          { type: 'done', finishReason: 'end_turn' },
        ),
      ),
    );

    const textChunks = chunks.filter((c) => c.type === 'text_delta') as Array<
      Extract<CompletionChunk, { type: 'text_delta' }>
    >;
    const allText = textChunks.map((c) => c.text).join('');
    expect(allText).toBe('<tool_call>partial content');

    const lastTextIdx = lastIndexOf(chunks, (c) => c.type === 'text_delta');
    const doneIdx = chunks.findIndex((c) => c.type === 'done');
    expect(doneIdx).toBeGreaterThan(lastTextIdx);
  });

  it('degrades oversized tool_call block to plain text', async () => {
    // Build a payload larger than 64 000 bytes inside a tool_call block
    const bigPayload = 'x'.repeat(65_000);
    const chunks = await collect(
      streamTextToolCalls(
        makeChunks(
          { type: 'text_delta', text: `<tool_call>${bigPayload}` },
          { type: 'done', finishReason: 'end_turn' },
        ),
      ),
    );

    // Should NOT produce any tool_use events
    expect(chunks.filter((c) => c.type === 'tool_use_start')).toHaveLength(0);

    // The oversized content should be emitted as text
    const textChunks = chunks.filter((c) => c.type === 'text_delta') as Array<
      Extract<CompletionChunk, { type: 'text_delta' }>
    >;
    const allText = textChunks.map((c) => c.text).join('');
    expect(allText).toContain(bigPayload);

    // done should still be emitted and NOT have finishReason adjusted
    const done = chunks.find((c) => c.type === 'done') as Extract<
      CompletionChunk,
      { type: 'done' }
    >;
    expect(done.finishReason).toBe('end_turn');
  });
});
