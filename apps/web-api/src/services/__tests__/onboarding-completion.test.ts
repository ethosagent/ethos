import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '../../repositories/config.repository';
import { OnboardingService } from '../onboarding.service';

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as unknown as Response;
  });
}

function makeService(fetchFn: typeof fetch) {
  return new OnboardingService({
    config: { read: async () => null, update: async () => {} } as unknown as ConfigRepository,
    personalities: { get: () => null } as unknown as FilePersonalityRegistry,
    secrets: new InMemorySecretsResolver(),
    fetchFn,
  });
}

describe('validateProvider completion test', () => {
  it('returns completionTested: true when completion succeeds', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { data: [{ id: 'claude-sonnet-4-20250514' }] } },
      { status: 200, body: { content: [{ text: 'h' }] } },
    ]);
    const svc = makeService(fetchFn as unknown as typeof fetch);
    const result = await svc.validateProvider({
      provider: 'anthropic',
      apiKey: 'sk-test',
    });
    expect(result.ok).toBe(true);
    expect(result.completionTested).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns human-readable error for billing failure', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { data: [{ id: 'gpt-4' }] } },
      { status: 402, body: { error: { message: 'insufficient_quota' } } },
    ]);
    const svc = makeService(fetchFn as unknown as typeof fetch);
    const result = await svc.validateProvider({
      provider: 'openai',
      apiKey: 'sk-test',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no credits');
    expect(result.completionTested).toBe(false);
    expect(result.models).toEqual(['gpt-4']);
  });

  it('skips completion test for ollama', async () => {
    const fetchFn = mockFetch([{ status: 200, body: { models: [{ name: 'llama3' }] } }]);
    const svc = makeService(fetchFn as unknown as typeof fetch);
    const result = await svc.validateProvider({
      provider: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434',
    });
    expect(result.ok).toBe(true);
    expect(result.completionTested).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns ok with completionTested false for model-specific 403', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { data: [{ id: 'claude-opus-4-7' }] } },
      { status: 403, body: { error: { message: 'access_denied' } } },
    ]);
    const svc = makeService(fetchFn as unknown as typeof fetch);
    const result = await svc.validateProvider({
      provider: 'anthropic',
      apiKey: 'sk-test',
    });
    expect(result.ok).toBe(true);
    expect(result.completionTested).toBe(false);
    expect(result.error).toBeNull();
  });

  it('picks a chat model over embedding models for openai', async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: {
          data: [
            { id: 'text-embedding-ada-002' },
            { id: 'dall-e-3' },
            { id: 'gpt-4' },
            { id: 'text-moderation-latest' },
          ],
        },
      },
      { status: 200, body: { choices: [{ message: { content: 'h' } }] } },
    ]);
    const svc = makeService(fetchFn as unknown as typeof fetch);
    const result = await svc.validateProvider({
      provider: 'openai',
      apiKey: 'sk-test',
    });
    expect(result.ok).toBe(true);
    expect(result.completionTested).toBe(true);
    const completionCall = fetchFn.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(completionCall[1].body as string);
    expect(body.model).toBe('gpt-4');
  });

  it('still fails for billing errors after model selection', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { data: [{ id: 'gpt-4' }] } },
      { status: 402, body: { error: { message: 'insufficient_quota' } } },
    ]);
    const svc = makeService(fetchFn as unknown as typeof fetch);
    const result = await svc.validateProvider({
      provider: 'openai',
      apiKey: 'sk-test',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no credits');
    expect(result.completionTested).toBe(false);
  });
});
