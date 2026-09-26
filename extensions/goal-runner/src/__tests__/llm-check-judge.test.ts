import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLMCheckJudge } from '../llm-check-judge';

interface Call {
  messages: Message[];
  options: CompletionOptions | undefined;
}

/** A provider whose `complete` is scripted per test; records every call. */
function fakeLlm(
  script: (options: CompletionOptions | undefined) => AsyncIterable<CompletionChunk>,
  capabilities?: Partial<ProviderCapabilities>,
): { llm: LLMProvider; calls: Call[] } {
  const calls: Call[] = [];
  const llm = {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    ...(capabilities
      ? { capabilities: { streaming: true, toolCalling: true, ...capabilities } }
      : {}),
    complete(messages: Message[], _tools: unknown, options?: CompletionOptions) {
      calls.push({ messages, options });
      return script(options);
    },
    countTokens: async () => 0,
  } as unknown as LLMProvider;
  return { llm, calls };
}

function reply(text: string) {
  return async function* (): AsyncIterable<CompletionChunk> {
    yield { type: 'text_delta', text } as CompletionChunk;
  };
}

const input = {
  check: { id: 'c1', description: 'All symbols of Nse_All_Stocks.csv are in the database' },
  goalText: 'Load every NSE symbol',
  output: 'Inserted 3169 of 3169 symbols; SELECT COUNT(*) → 3169',
};

describe('createLLMCheckJudge', () => {
  it('returns the model verdict and its one-line evidence', async () => {
    const { llm, calls } = fakeLlm(reply('{"met": true, "evidence": "COUNT(*) = 3169 of 3169"}'));
    const result = await createLLMCheckJudge({ llm })(input);

    expect(result).toEqual({ pass: true, evidence: 'COUNT(*) = 3169 of 3169' });
    expect(calls).toHaveLength(1);
    const content = String(calls[0]?.messages[0]?.content);
    expect(content).toContain(input.check.description);
    expect(content).toContain(input.goalText);
    expect(content).toContain(input.output);
  });

  it('tells the model that a claim without concrete evidence is not proof', async () => {
    const { llm, calls } = fakeLlm(reply('{"met": false, "evidence": "no counts"}'));
    await createLLMCheckJudge({ llm })(input);

    const system = calls[0]?.options?.system ?? '';
    expect(system).toMatch(/claim without concrete evidence is NOT proof/);
    expect(system).toMatch(/counts|ids|command output/);
    expect(calls[0]?.options?.temperature).toBe(0);
  });

  it('passes a not-met verdict through', async () => {
    const { llm } = fakeLlm(reply('{"met": false, "evidence": "only a plan, no rows inserted"}'));
    expect(await createLLMCheckJudge({ llm })(input)).toEqual({
      pass: false,
      evidence: 'only a plan, no rows inserted',
    });
  });

  it('requests structured output only from a structured-output-capable provider', async () => {
    const plain = fakeLlm(reply('{"met": true, "evidence": "x"}'));
    await createLLMCheckJudge({ llm: plain.llm })(input);
    expect(plain.calls[0]?.options?.providerOptions).toBeUndefined();

    const capable = fakeLlm(reply('{"met": true, "evidence": "x"}'), { structuredOutput: true });
    await createLLMCheckJudge({ llm: capable.llm })(input);
    expect(capable.calls[0]?.options?.providerOptions).toBeDefined();
  });

  it('fails closed when the provider throws', async () => {
    const { llm } = fakeLlm(() => {
      throw new Error('401 invalid api key');
    });
    expect(await createLLMCheckJudge({ llm })(input)).toEqual({
      pass: false,
      evidence: 'judge unavailable: 401 invalid api key',
    });
  });

  it('fails closed on an unparseable reply', async () => {
    const { llm } = fakeLlm(reply('Yes, looks done to me.'));
    const result = await createLLMCheckJudge({ llm })(input);
    expect(result.pass).toBe(false);
    expect(result.evidence).toMatch(/^judge unavailable: unparseable verdict/);
  });

  it('fails closed and aborts the call when it exceeds the timeout', async () => {
    let signal: AbortSignal | undefined;
    const { llm } = fakeLlm((options) => {
      signal = options?.abortSignal;
      return (async function* (): AsyncIterable<CompletionChunk> {
        await new Promise(() => {}); // never answers
      })();
    });
    const result = await createLLMCheckJudge({ llm, timeoutMs: 20 })(input);

    expect(result).toEqual({ pass: false, evidence: 'judge unavailable: timed out after 20ms' });
    expect(signal?.aborted).toBe(true);
  });
});
