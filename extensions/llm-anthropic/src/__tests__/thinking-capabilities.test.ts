// Presence §4 fix pass — the per-model thinking capability table
// (`anthropicModelCapabilities`) and what it does to the wire: adaptive models
// get `thinking: {type:'adaptive'}` + `output_config.effort`, budget models get
// `budget_tokens`, unknown models get neither; sampling params are dropped
// where the model refuses them; and a budget-mode request that continues a
// tool loop does not enable thinking it cannot satisfy (the prior assistant
// turn's thinking blocks are not replayed). Wire bytes via the SDK's fetch seam.

import type { CompletionOptions, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, anthropicModelCapabilities, EFFORT_THINKING_BUDGET } from '../index';

function sse(events: Array<Record<string, unknown>>): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`;
}

const okBody = sse([
  {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'm',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: 'message_stop' },
]);

const hello: Message[] = [{ role: 'user', content: 'hello' }];

// biome-ignore lint/suspicious/noExplicitAny: parsed wire JSON
async function send(model: string, options: CompletionOptions, messages = hello): Promise<any> {
  const captured: string[] = [];
  const provider = new AnthropicProvider({
    apiKey: 'test-key',
    model,
    maxOutputTokens: 32_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      captured.push(String(init?.body ?? ''));
      return new Response(okBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  for await (const _ of provider.complete(messages, [], options)) {
    // drain
  }
  const body = captured[0];
  if (body === undefined) throw new Error('no messages request was sent');
  return JSON.parse(body);
}

describe('anthropicModelCapabilities', () => {
  it.each([
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-sonnet-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ])('%s is adaptive', (id) => {
    expect(anthropicModelCapabilities(id).mode).toBe('adaptive');
  });

  it.each([
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-opus-4',
    'claude-sonnet-4',
    'claude-3-7-sonnet',
  ])('%s is budget', (id) => {
    expect(anthropicModelCapabilities(id).mode).toBe('budget');
  });

  it.each(['claude-mythos-5', 'claude-opus-9', 'claude-3-5-sonnet', 'gpt-4o', ''])(
    '%s is unknown: no thinking, sampling kept',
    (id) => {
      const caps = anthropicModelCapabilities(id);
      expect(caps.mode).toBe('none');
      expect(caps.effortLevels).toEqual([]);
    },
  );

  it.each([
    ['claude-sonnet-4-5-20250929', 'budget', 'claude-sonnet-4-5'],
    ['claude-haiku-4-5-20251001', 'budget', 'claude-haiku-4-5'],
    ['us.anthropic.claude-sonnet-4-20250514-v1:0', 'budget', 'claude-sonnet-4'],
    ['anthropic.claude-opus-4-1-20250805-v1:0', 'budget', 'claude-opus-4-1'],
    ['global.anthropic.claude-opus-4-6-v1', 'adaptive', 'claude-opus-4-6'],
    ['claude-opus-4-1@20250805', 'budget', 'claude-opus-4-1'],
    ['claude-3-7-sonnet-latest', 'budget', 'claude-3-7-sonnet'],
    ['anthropic/claude-opus-4.8', 'adaptive', 'claude-opus-4-8'],
    ['anthropic/claude-opus-5.5', 'adaptive', 'claude-opus-5-5'],
    ['claude-opus-4-8[1m]', 'adaptive', 'claude-opus-4-8'],
  ])('normalizes %s', (id, mode, base) => {
    const caps = anthropicModelCapabilities(id);
    expect(caps.mode).toBe(mode);
    expect(caps.id).toBe(base);
  });

  it('an older model id is never read as a newer sibling (no substring match)', () => {
    // `claude-opus-4` must not swallow `claude-opus-4-8`, nor the reverse.
    expect(anthropicModelCapabilities('claude-opus-4-20250514').id).toBe('claude-opus-4');
    expect(anthropicModelCapabilities('claude-opus-4-8').id).toBe('claude-opus-4-8');
  });

  it('sampling is refused on the current generation, allowed on 4.6 and older', () => {
    for (const id of [
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
    ]) {
      expect(anthropicModelCapabilities(id).samplingAllowed, id).toBe(false);
    }
    for (const id of [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-3-7-sonnet',
    ]) {
      expect(anthropicModelCapabilities(id).samplingAllowed, id).toBe(true);
    }
  });
});

describe('adaptive models on the wire', () => {
  it('effort high → adaptive thinking + output_config.effort, never budget_tokens', async () => {
    const body = await send('claude-opus-4-8', { effort: 'high' });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('works for a Bedrock-style id too', async () => {
    const body = await send('global.anthropic.claude-opus-4-6-v1', { effort: 'medium' });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  it("'off' on a model that does not think unprompted sends nothing", async () => {
    const off = await send('claude-opus-4-8', { effort: 'off' });
    expect(off.thinking).toBeUndefined();
    expect(off.output_config).toBeUndefined();
  });

  it("'off' on Opus 5 (thinks by default, disable accepted ≤ high) → disabled + low", async () => {
    const body = await send('claude-opus-5', { effort: 'off' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toEqual({ effort: 'low' });
  });

  it("'off' on a model that cannot disable thinking → thinking omitted, effort low", async () => {
    for (const id of ['claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1']) {
      const body = await send(id, { effort: 'off' });
      expect(body.thinking, id).toBeUndefined();
      expect(body.output_config, id).toEqual({ effort: 'low' });
    }
  });

  it('an explicit thinkingBudget maps to adaptive thinking (no budget_tokens → no 400)', async () => {
    const plain = await send('claude-opus-4-8', { thinkingBudget: 2000 });
    expect(plain.thinking).toEqual({ type: 'adaptive' });
    expect(plain.output_config).toBeUndefined();
    const withEffort = await send('claude-opus-4-8', { thinkingBudget: 2000, effort: 'low' });
    expect(withEffort.thinking).toEqual({ type: 'adaptive' });
    expect(withEffort.output_config).toEqual({ effort: 'low' });
  });

  it('with no effort and no budget the body carries neither field', async () => {
    const body = await send('claude-opus-5-5', {});
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});

describe('unknown models on the wire', () => {
  it('get no thinking and no effort', async () => {
    const body = await send('claude-mythos-5', { effort: 'high', thinkingBudget: 4000 });
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});

describe('sampling params', () => {
  it('top_p is dropped where the model refuses sampling', async () => {
    const body = await send('claude-opus-4-8', { topP: 0.9 });
    expect(body.top_p).toBeUndefined();
    const fable = await send('claude-fable-5', { topP: 0.9 });
    expect(fable.top_p).toBeUndefined();
  });

  it('top_p is kept on a sampling model with no thinking', async () => {
    expect((await send('claude-sonnet-4-6', { topP: 0.9 })).top_p).toBe(0.9);
    expect((await send('claude-sonnet-4-5', { topP: 0.9 })).top_p).toBe(0.9);
  });

  it('with budget thinking on, a top_p below 0.95 is dropped and one ≥ 0.95 kept', async () => {
    const low = await send('claude-sonnet-4-5', { effort: 'high', topP: 0.9 });
    expect(low.thinking.type).toBe('enabled');
    expect(low.top_p).toBeUndefined();
    const high = await send('claude-sonnet-4-5', { effort: 'high', topP: 0.97 });
    expect(high.top_p).toBe(0.97);
  });

  it('temperature is never sent by this provider', async () => {
    const body = await send('claude-sonnet-4-5', { temperature: 0.2 });
    expect(body.temperature).toBeUndefined();
  });
});

describe('thinking across a tool loop', () => {
  const toolLoop: Message[] = [
    { role: 'user', content: 'what is in README?' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'README.md' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '# Ethos' }],
    },
  ];

  it('iteration 1 thinks; iteration 2 (continuing a tool_use turn) does not', async () => {
    const first = await send('claude-sonnet-4-5', { effort: 'high' }, [toolLoop[0] as Message]);
    expect(first.thinking).toEqual({
      type: 'enabled',
      budget_tokens: EFFORT_THINKING_BUDGET.high,
    });
    const second = await send('claude-sonnet-4-5', { effort: 'high' }, toolLoop);
    expect(second.thinking).toBeUndefined();
  });

  it('opus-4-8 (no thinking by default): iteration 1 adaptive + effort, iteration 2 effort only', async () => {
    const first = await send('claude-opus-4-8', { effort: 'high' }, [toolLoop[0] as Message]);
    expect(first.thinking).toEqual({ type: 'adaptive' });
    expect(first.output_config).toEqual({ effort: 'high' });
    const second = await send('claude-opus-4-8', { effort: 'high' }, toolLoop);
    expect(second.thinking).toBeUndefined();
    expect(second.output_config).toEqual({ effort: 'high' });
  });

  it('an explicit thinkingBudget on sonnet-4-6 is held back mid tool loop', async () => {
    const body = await send('claude-sonnet-4-6', { thinkingBudget: 2000 }, toolLoop);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('a model that thinks by default keeps its request unchanged mid tool loop', async () => {
    const high = await send('claude-opus-5-5', { effort: 'high' }, toolLoop);
    expect(high.thinking).toEqual({ type: 'adaptive' });
    expect(high.output_config).toEqual({ effort: 'high' });
    const off = await send('claude-opus-5', { effort: 'off' }, toolLoop);
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.output_config).toEqual({ effort: 'low' });
  });

  it('thinksByDefault is recorded in the table', () => {
    for (const id of [
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-sonnet-5',
    ]) {
      expect(anthropicModelCapabilities(id).thinksByDefault, id).toBe(true);
    }
    for (const id of [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]) {
      expect(anthropicModelCapabilities(id).thinksByDefault, id).toBe(false);
    }
  });

  it('an explicit thinkingBudget is held back mid tool loop too', async () => {
    const body = await send('claude-sonnet-4-5', { thinkingBudget: 2000 }, toolLoop);
    expect(body.thinking).toBeUndefined();
  });

  it('a fresh user turn after the tool loop thinks again', async () => {
    const next: Message[] = [
      ...toolLoop,
      { role: 'assistant', content: 'It says Ethos.' },
      { role: 'user', content: 'thanks, and the license?' },
    ];
    const body = await send('claude-sonnet-4-5', { effort: 'high' }, next);
    expect(body.thinking.type).toBe('enabled');
  });
});
