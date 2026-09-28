// UBP-032 spec check (2026-09-28, no live Gemini test by owner decision).
// Fixtures follow the "Chat Completions" examples in Google's thought-signature
// documentation (cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures;
// ai.google.dev/gemini-api/docs/openai links to the same guide):
//
//  - a signature arrives on a tool call as `extra_content.google.thought_signature`;
//  - sequential calls in one turn: each step's tool call is signed, and the
//    step-3 request must carry SIGNATURE_A and SIGNATURE_B on their own calls;
//  - parallel calls: only the first tool call is signed, and only it is sent
//    back with the field.
//
// The docs show whole messages, not stream chunks, so the streaming fixtures
// also put the signature on a LATER delta of the same tool-call index — the
// transport reads it from any delta (`geminiThoughtSignature`, ../transport).

import type { CompletionChunk, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

function sse(deltas: unknown[], finish: string): string {
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  return `${deltas.map((d) => chunk(d, null)).join('')}${chunk({}, finish)}data: [DONE]\n\n`;
}

const TEXT = sse([{ content: 'done' }], 'stop');

function provider(replies: string[], bodies: string[]): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'gemini',
    model: 'gemini-3-pro-preview',
    apiKey: 'k',
    baseUrl: BASE,
    fetchImpl: (async (_input: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(replies.shift() ?? TEXT, {
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

function ends(chunks: CompletionChunk[]) {
  return chunks.flatMap((c) =>
    c.type === 'tool_use_end' ? [{ id: c.toolCallId, input: JSON.parse(c.inputJson) }] : [],
  );
}

const TOOLS = [
  { name: 'check_flight', description: 'x', parameters: { type: 'object', properties: {} } },
  { name: 'book_taxi', description: 'x', parameters: { type: 'object', properties: {} } },
  {
    name: 'get_current_temperature',
    description: 'x',
    parameters: { type: 'object', properties: {} },
  },
];

type Body = { messages: Array<{ role: string; tool_calls?: Array<Record<string, unknown>> }> };

describe('Gemini OpenAI-compat thought signatures — documented Chat Completions flows', () => {
  it('sequential: step 3 carries SIGNATURE_A and SIGNATURE_B on their own tool calls', async () => {
    const ID_A = 'function-call-1d6a1a61-6f4f-4029-80ce-61586bd86da5';
    const ID_B = 'function-call-65b325ba-9b40-4003-9535-8c7137b35634';
    const bodies: string[] = [];
    const p = provider(
      [
        sse(
          [
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: ID_A,
                  type: 'function',
                  function: { name: 'check_flight', arguments: '' },
                },
              ],
            },
            {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"flight":"AA100"}' },
                  extra_content: { google: { thought_signature: '<SIGNATURE_A>' } },
                },
              ],
            },
          ],
          'tool_calls',
        ),
        sse(
          [
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: ID_B,
                  type: 'function',
                  function: { name: 'book_taxi', arguments: '{"time":"10 AM"}' },
                  extra_content: { google: { thought_signature: '<SIGNATURE_B>' } },
                },
              ],
            },
          ],
          'tool_calls',
        ),
        TEXT,
      ],
      bodies,
    );
    const history: Message[] = [
      {
        role: 'user',
        content: 'Check flight status for AA100 and book a taxi 2 hours before if delayed.',
      },
    ];
    const [a] = ends(await drain(p.complete(history, TOOLS, {})));
    if (!a) throw new Error('no call A');
    history.push(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: a.id, name: 'check_flight', input: a.input }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: a.id,
            content: '{"status":"delayed","departure_time":"12 PM"}',
          },
        ],
      },
    );
    const [b] = ends(await drain(p.complete(history, TOOLS, {})));
    if (!b) throw new Error('no call B');
    history.push(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: b.id, name: 'book_taxi', input: b.input }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: b.id, content: '{"booking_status":"success"}' },
        ],
      },
    );
    await drain(p.complete(history, TOOLS, {}));

    const step3 = JSON.parse(bodies[2] ?? '{}') as Body;
    const calls = step3.messages.flatMap((m) => m.tool_calls ?? []);
    expect(calls).toEqual([
      {
        id: ID_A,
        type: 'function',
        function: { name: 'check_flight', arguments: '{"flight":"AA100"}' },
        extra_content: { google: { thought_signature: '<SIGNATURE_A>' } },
      },
      {
        id: ID_B,
        type: 'function',
        function: { name: 'book_taxi', arguments: '{"time":"10 AM"}' },
        extra_content: { google: { thought_signature: '<SIGNATURE_B>' } },
      },
    ]);
    expect(step3.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
  });

  it('parallel: only the first (signed) tool call is sent back with extra_content', async () => {
    const bodies: string[] = [];
    const p = provider(
      [
        sse(
          [
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-f3b9ecb3-d55f-4076-98c8-b13e9d1c0e01',
                  type: 'function',
                  function: { name: 'get_current_temperature', arguments: '{"location":"Paris"}' },
                  extra_content: { google: { thought_signature: '<SIGNATURE_A>' } },
                },
                {
                  index: 1,
                  id: 'function-call-335673ad-913e-42d1-bbf5-387c8ab80f44',
                  type: 'function',
                  function: { name: 'get_current_temperature', arguments: '{"location":"London"}' },
                },
              ],
            },
          ],
          'tool_calls',
        ),
        TEXT,
      ],
      bodies,
    );
    const prompt = 'Check the weather in Paris and London.';
    const calls = ends(await drain(p.complete([{ role: 'user', content: prompt }], TOOLS, {})));
    expect(calls).toHaveLength(2);
    await drain(
      p.complete(
        [
          { role: 'user', content: prompt },
          {
            role: 'assistant',
            content: calls.map((c) => ({
              type: 'tool_use' as const,
              id: c.id,
              name: 'get_current_temperature',
              input: c.input,
            })),
          },
          {
            role: 'user',
            content: calls.map((c, i) => ({
              type: 'tool_result' as const,
              tool_use_id: c.id,
              content: i === 0 ? '{"temp":"15C"}' : '{"temp":"12C"}',
            })),
          },
        ],
        TOOLS,
        {},
      ),
    );
    const turn2 = JSON.parse(bodies[1] ?? '{}') as Body;
    const replayed = turn2.messages.flatMap((m) => m.tool_calls ?? []);
    expect(replayed.map((c) => c.extra_content)).toEqual([
      { google: { thought_signature: '<SIGNATURE_A>' } },
      undefined,
    ]);
    // All calls precede all responses (FC1+sig, FC2, FR1, FR2).
    expect(turn2.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
  });
});

// A tool call Gemini never signed — one another provider made before a
// failover, or one from before a restart — gets Google's documented dummy
// signature on Gemini 3 ("you can set the following dummy signatures of either
// `context_engineering_is_the_way_to_go` or `skip_thought_signature_validator`",
// ai.google.dev/gemini-api/docs/generate-content/thought-signatures, fetched
// 2026-09-28), as `extra_content.google.thought_signature`. Only the first call
// of a message, and never for a model that is not Gemini 3.
describe('unsigned tool calls in history (failover / restart)', () => {
  const unsigned: Message[] = [
    { role: 'user', content: 'check both flights' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_x', name: 'check_flight', input: { flight: 'AA100' } },
        { type: 'tool_use', id: 'call_y', name: 'check_flight', input: { flight: 'UA200' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_x', content: 'on time' },
        { type: 'tool_result', tool_use_id: 'call_y', content: 'delayed' },
      ],
    },
  ];

  function sentCalls(body: string | undefined) {
    const parsed = JSON.parse(body ?? '{}') as {
      messages: Array<{
        role: string;
        tool_calls?: Array<{
          id: string;
          extra_content?: { google?: { thought_signature?: string } };
        }>;
      }>;
    };
    return parsed.messages.find((m) => m.role === 'assistant')?.tool_calls ?? [];
  }

  function providerFor(model: string, bodies: string[]): OpenAICompatProvider {
    return new OpenAICompatProvider({
      name: 'gemini',
      model,
      apiKey: 'k',
      baseUrl: BASE,
      fetchImpl: (async (_input: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(TEXT, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof globalThis.fetch,
    });
  }

  it('Gemini 3: the first unsigned call carries skip_thought_signature_validator, the second none', async () => {
    const bodies: string[] = [];
    await drain(providerFor('gemini-3-pro-preview', bodies).complete(unsigned, TOOLS, {}));
    const calls = sentCalls(bodies[0]);
    expect(calls[0]?.extra_content?.google?.thought_signature).toBe(
      'skip_thought_signature_validator',
    );
    expect(calls[1]).not.toHaveProperty('extra_content');
  });

  it('a modelOverride to Gemini 3 gets it too', async () => {
    const bodies: string[] = [];
    await drain(
      providerFor('gemini-2.5-flash', bodies).complete(unsigned, TOOLS, {
        modelOverride: 'gemini-3-flash-preview',
      }),
    );
    expect(sentCalls(bodies[0])[0]?.extra_content?.google?.thought_signature).toBe(
      'skip_thought_signature_validator',
    );
  });

  it('a model that is not Gemini 3 never gets the dummy', async () => {
    const bodies: string[] = [];
    await drain(providerFor('gemini-2.5-flash', bodies).complete(unsigned, TOOLS, {}));
    for (const call of sentCalls(bodies[0])) expect(call).not.toHaveProperty('extra_content');
  });
});
