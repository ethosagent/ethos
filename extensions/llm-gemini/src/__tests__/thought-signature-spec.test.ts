// UBP-032 spec check (2026-09-28, no live Gemini test by owner decision).
// Fixtures follow Google's thought-signature documentation for REST
// generateContent ("Sequential function calling example" and "Parallel
// function calling example", cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures):
//
//  - parallel calls: only the FIRST functionCall part carries thoughtSignature;
//  - sequential calls in one turn: EACH step's functionCall part carries one,
//    and the request for step N must replay every earlier step's signature on
//    its own part (validation runs over every step of the current turn);
//  - a signature is sent back inside its original part, never merged.

import type { CompletionChunk, Message } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiNativeProvider } from '../index';

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

function stubFetch(...responses: Response[]): unknown[] {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      const next = responses.shift();
      if (!next) throw new Error('unexpected extra fetch');
      return next;
    }),
  );
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function modelCall(name: string, args: Record<string, unknown>, signature?: string) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { functionCall: { name, args }, ...(signature ? { thoughtSignature: signature } : {}) },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  };
}

function toolUseEnd(chunks: CompletionChunk[]): { id: string; input: unknown } {
  const end = chunks.find((c) => c.type === 'tool_use_end');
  if (end?.type !== 'tool_use_end') throw new Error('no tool call');
  return { id: end.toolCallId, input: JSON.parse(end.inputJson) };
}

describe('gemini-native thought signatures — documented sequential flow', () => {
  it('replays SIGNATURE_A and SIGNATURE_B on their own parts in step 3', async () => {
    const bodies = stubFetch(
      sse([modelCall('check_flight', { flight: 'AA100' }, '<SIGNATURE_A>')]),
      sse([modelCall('book_taxi', { time: '10 AM' }, '<SIGNATURE_B>')]),
      sse([{ candidates: [{ content: { parts: [{ text: 'Booked.' }] }, finishReason: 'STOP' }] }]),
    );
    const provider = new GeminiNativeProvider({ apiKey: 'k', model: 'gemini-3-pro-preview' });
    const prompt = 'Check flight status for AA100 and book a taxi 2 hours before if delayed.';
    const history: Message[] = [{ role: 'user', content: prompt }];

    const a = toolUseEnd(await drain(provider.complete(history, [], {})));
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
    const b = toolUseEnd(await drain(provider.complete(history, [], {})));
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
    await drain(provider.complete(history, [], {}));

    const step2 = bodies[1] as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(step2.contents[1]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: { name: 'check_flight', args: { flight: 'AA100' } },
          thoughtSignature: '<SIGNATURE_A>',
        },
      ],
    });

    const step3 = bodies[2] as { contents: Array<{ role: string; parts: unknown[] }> };
    const modelTurns = step3.contents.filter((c) => c.role === 'model');
    expect(modelTurns).toEqual([
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'check_flight', args: { flight: 'AA100' } },
            thoughtSignature: '<SIGNATURE_A>',
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'book_taxi', args: { time: '10 AM' } },
            thoughtSignature: '<SIGNATURE_B>',
          },
        ],
      },
    ]);
  });

  it('parallel calls: the signature stays on the first part and all calls precede all responses', async () => {
    const bodies = stubFetch(
      sse([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'get_current_temperature', args: { location: 'Paris' } },
                    thoughtSignature: '<SIGNATURE_A>',
                  },
                  {
                    functionCall: { name: 'get_current_temperature', args: { location: 'London' } },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
      sse([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]),
    );
    const provider = new GeminiNativeProvider({ apiKey: 'k', model: 'gemini-3-pro-preview' });
    const turn1 = await drain(
      provider.complete(
        [{ role: 'user', content: 'Check the weather in Paris and London.' }],
        [],
        {},
      ),
    );
    const calls = turn1.flatMap((c) =>
      c.type === 'tool_use_end' ? [{ id: c.toolCallId, input: JSON.parse(c.inputJson) }] : [],
    );
    expect(calls).toHaveLength(2);
    await drain(
      provider.complete(
        [
          { role: 'user', content: 'Check the weather in Paris and London.' },
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
              content: i === 0 ? '15C' : '12C',
            })),
          },
        ],
        [],
        {},
      ),
    );
    const turn2 = bodies[1] as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(turn2.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(turn2.contents[1]?.parts.map((p) => 'thoughtSignature' in p)).toEqual([true, false]);
    expect(turn2.contents[1]?.parts[0]?.thoughtSignature).toBe('<SIGNATURE_A>');
    expect(turn2.contents[2]?.parts.every((p) => 'functionResponse' in p)).toBe(true);
  });
});

// A functionCall Gemini never signed (another provider's call before a
// failover, or one from before a restart) gets Google's documented dummy
// `thoughtSignature: "skip_thought_signature_validator"` beside the
// functionCall on Gemini 3 (ai.google.dev/gemini-api/docs/generate-content/
// thought-signatures, fetched 2026-09-28): only the first call of a model
// turn, only for a gemini-3* model.
describe('unsigned functionCall parts in history (failover / restart)', () => {
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

  function modelParts(body: unknown) {
    const contents = (body as { contents: Array<{ role: string; parts: unknown[] }> }).contents;
    return (contents.find((c) => c.role === 'model')?.parts ?? []) as Array<
      Record<string, unknown>
    >;
  }

  it('Gemini 3: the first unsigned functionCall carries the dummy, the second none', async () => {
    const bodies = stubFetch(
      sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }]),
    );
    const p = new GeminiNativeProvider({ apiKey: 'k', model: 'gemini-3-pro-preview' });
    await drain(p.complete(unsigned, [], {}));
    const parts = modelParts(bodies[0]);
    expect(parts[0]?.thoughtSignature).toBe('skip_thought_signature_validator');
    expect(parts[1]).not.toHaveProperty('thoughtSignature');
  });

  it('a model that is not Gemini 3 never gets the dummy', async () => {
    const bodies = stubFetch(
      sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }]),
    );
    const p = new GeminiNativeProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    await drain(p.complete(unsigned, [], {}));
    for (const part of modelParts(bodies[0])) expect(part).not.toHaveProperty('thoughtSignature');
  });
});
