import { describe, expect, it } from 'vitest';
import { fetchLocalModels, parseOpenAiModelsResponse } from '../setup';

describe('parseOpenAiModelsResponse', () => {
  it('extracts model ids from a valid openai-compat body', () => {
    const body = { data: [{ id: 'llama3.2' }, { id: 'qwen2.5' }] };
    expect(parseOpenAiModelsResponse(body)).toEqual(['llama3.2', 'qwen2.5']);
  });

  it('returns [] for a malformed body (structural guard, no throw)', () => {
    expect(parseOpenAiModelsResponse(null)).toEqual([]);
    expect(parseOpenAiModelsResponse('nope')).toEqual([]);
    expect(parseOpenAiModelsResponse({ data: 'nope' })).toEqual([]);
    expect(parseOpenAiModelsResponse({ data: [{ name: 'no-id' }, 42, null] })).toEqual([]);
    expect(parseOpenAiModelsResponse({})).toEqual([]);
  });

  it('skips entries with empty or non-string ids', () => {
    const body = { data: [{ id: '' }, { id: 'good' }, { id: 123 }] };
    expect(parseOpenAiModelsResponse(body)).toEqual(['good']);
  });
});

describe('fetchLocalModels', () => {
  const okResponse = (body: unknown): Response =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it('returns the served models when the endpoint is reachable', async () => {
    const fetchImpl = (async () =>
      okResponse({ data: [{ id: 'llama3.2' }, { id: 'mistral' }] })) as unknown as typeof fetch;

    const result = await fetchLocalModels('http://localhost:11434/v1', { fetchImpl });
    expect(result).toEqual({ reachable: true, models: ['llama3.2', 'mistral'] });
  });

  it('appends /models to the base URL (trailing slash tolerant)', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return okResponse({ data: [{ id: 'x' }] });
    }) as unknown as typeof fetch;

    await fetchLocalModels('http://localhost:8000/v1/', { fetchImpl });
    expect(calledUrl).toBe('http://localhost:8000/v1/models');
  });

  it('falls back (reachable: false) when the endpoint errors or times out', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await fetchLocalModels('http://localhost:8000/v1', { fetchImpl });
    expect(result).toEqual({ reachable: false, models: [] });
  });

  it('falls back on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;

    const result = await fetchLocalModels('http://localhost:8000/v1', { fetchImpl });
    expect(result).toEqual({ reachable: false, models: [] });
  });

  it('falls back when the endpoint answers but the model list is malformed/empty', async () => {
    const fetchImpl = (async () => okResponse({ data: [] })) as unknown as typeof fetch;

    const result = await fetchLocalModels('http://localhost:8000/v1', { fetchImpl });
    expect(result).toEqual({ reachable: false, models: [] });
  });
});
