// UBP-032 — Gemini 3 thought signatures on the OpenAI-compat path. Gemini's
// compat endpoint streams a signature on a tool call as
// `extra_content.google.thought_signature`; the provider keeps it (D5: a
// provider-held map keyed by tool-call id, no contract change) and sends it
// back on that tool call in the next request, byte for byte. Non-Gemini
// endpoints never read or send the field.

import type { CompletionChunk, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';

const SIGNATURE = 'CiQBVHh0U2lnbmF0dXJlLTEyMw==';

function toolCallSse(): string {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return (
    chunk(
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'function-call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
            extra_content: { google: { thought_signature: SIGNATURE } },
          },
        ],
      },
      null,
    ) +
    chunk({}, 'tool_calls') +
    'data: [DONE]\n\n'
  );
}

const TEXT_SSE =
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\n` +
  'data: [DONE]\n\n';

function provider(baseUrl: string, bodies: string[]): OpenAICompatProvider {
  const replies = [toolCallSse(), TEXT_SSE];
  return new OpenAICompatProvider({
    name: 'gemini',
    model: 'gemini-3-pro-preview',
    apiKey: 'k',
    baseUrl,
    fetchImpl: (async (_input: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(replies.shift() ?? TEXT_SSE, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch,
  });
}

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

const TOOLS = [
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
];

async function twoTurns(baseUrl: string): Promise<Record<string, unknown>> {
  const bodies: string[] = [];
  const p = provider(baseUrl, bodies);
  const first = await drain(p.complete([{ role: 'user', content: 'go' }], TOOLS, {}));
  const end = first.find((c) => c.type === 'tool_use_end');
  if (end?.type !== 'tool_use_end') throw new Error('no tool call');
  const history: Message[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: end.toolCallId,
          name: 'read_file',
          input: JSON.parse(end.inputJson),
        },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: end.toolCallId, content: 'x' }] },
  ];
  await drain(p.complete(history, TOOLS, {}));
  return JSON.parse(bodies[1] ?? '{}') as Record<string, unknown>;
}

describe('Gemini thought signatures on the OpenAI-compat path (UBP-032)', () => {
  it('replays the turn-1 signature byte for byte on the turn-2 tool call', async () => {
    const body = await twoTurns('https://generativelanguage.googleapis.com/v1beta/openai');
    const messages = body.messages as Array<{ role: string; tool_calls?: unknown[] }>;
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls).toEqual([
      {
        id: 'function-call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
        extra_content: { google: { thought_signature: SIGNATURE } },
      },
    ]);
  });

  it('never sends extra_content to a non-Gemini endpoint', async () => {
    const body = await twoTurns('https://openrouter.ai/api/v1');
    expect(JSON.stringify(body)).not.toContain('extra_content');
  });
});
