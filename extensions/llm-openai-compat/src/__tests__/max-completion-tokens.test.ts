// UBP-038 — OpenAI's reasoning models (o-series, gpt-5.x) refuse `max_tokens`
// on Chat Completions. Requests to api.openai.com, and reasoning-family model
// ids on any hosted endpoint, send `max_completion_tokens`; local runtimes and
// the other hosted dialects keep `max_tokens`, so their golden bodies are
// byte-identical to before.

import type { CompletionChunk } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';
import { buildChatCompletionsParams, isOpenAiReasoningModelId, outputCapParam } from '../transport';

const SSE = [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}`,
  '',
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

async function wireBody(name: string, baseUrl: string, model: string): Promise<string> {
  const bodies: string[] = [];
  const provider = new OpenAICompatProvider({
    name,
    model,
    apiKey: 'k',
    baseUrl,
    fetchImpl: (async (_input: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch,
  });
  const drain = async (iter: AsyncIterable<CompletionChunk>) => {
    for await (const _ of iter) {
      // drain
    }
  };
  await drain(provider.complete([{ role: 'user', content: 'hi' }], [], { maxTokens: 256 }));
  return bodies[0] ?? '';
}

describe('output-cap parameter (UBP-038)', () => {
  it('sends max_completion_tokens to api.openai.com for a gpt-5.x model', async () => {
    const body = await wireBody('openai', 'https://api.openai.com/v1', 'gpt-5.6-sol');
    expect(body).toContain('"max_completion_tokens":256');
    expect(body).not.toContain('"max_tokens"');
  });

  it('sends max_completion_tokens to api.openai.com for a non-reasoning model too', async () => {
    const body = await wireBody('openai', 'https://api.openai.com/v1', 'gpt-4o-mini');
    expect(body).toContain('"max_completion_tokens":256');
    expect(body).not.toContain('"max_tokens"');
  });

  it('keeps max_tokens for other hosted dialects and vendor-prefixed ids', async () => {
    const body = await wireBody('openrouter', 'https://openrouter.ai/api/v1', 'openai/gpt-5.6-sol');
    expect(body).toContain('"max_tokens":256');
    expect(body).not.toContain('max_completion_tokens');
  });

  it('keeps max_tokens for a local runtime whatever the model is called', async () => {
    const body = await wireBody('ollama', 'http://localhost:11434/v1', 'o3');
    expect(body).toContain('"max_tokens":256');
    expect(body).not.toContain('max_completion_tokens');
  });

  it('sends max_completion_tokens for a bare reasoning id behind another hosted endpoint', () => {
    const params = buildChatCompletionsParams([], [], { maxTokens: 64 }, 'o4-mini');
    const wire = JSON.stringify(params.oaiParams);
    expect(wire).toContain('"max_completion_tokens":64');
    expect(wire).not.toContain('"max_tokens"');
  });

  it('leaves the bare builder unchanged for an ordinary model id', () => {
    const params = buildChatCompletionsParams([], [], { maxTokens: 64 }, 'm');
    expect(JSON.stringify(params.oaiParams)).toContain('"max_tokens":64');
  });

  // V-CP-5 — Azure addresses a DEPLOYMENT, whose name is the model id Ethos
  // sees. The rule stays the model-id rule there (the portal names a
  // deployment after its model by default): a deployment named for a
  // reasoning family gets max_completion_tokens, anything else keeps
  // max_tokens (outputCapParam's doc says why it is not sent everywhere).
  it('Azure: a deployment named for a reasoning family gets max_completion_tokens', async () => {
    const body = await wireBody('azure', 'https://res.openai.azure.com', 'o3-mini');
    expect(body).toContain('"max_completion_tokens":256');
    expect(body).not.toContain('"max_tokens"');
  });

  it('Azure: any other deployment name keeps max_tokens', async () => {
    for (const deployment of ['gpt-4o', 'prod-chat']) {
      const body = await wireBody('azure', 'https://res.openai.azure.com', deployment);
      expect(body).toContain('"max_tokens":256');
      expect(body).not.toContain('max_completion_tokens');
    }
  });

  it('matches only the reasoning families', () => {
    for (const id of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.6-sol', 'GPT-5-mini']) {
      expect(isOpenAiReasoningModelId(id)).toBe(true);
    }
    for (const id of ['gpt-4o', 'gpt-oss-120b', 'openai/gpt-5', 'ollama3', 'omni', 'gpt-50x']) {
      expect(isOpenAiReasoningModelId(id)).toBe(false);
    }
    expect(outputCapParam('gpt-5', { localRuntime: 'vllm' })).toBe('max_tokens');
  });
});
