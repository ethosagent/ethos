import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAiRoutes } from '../../routes/openai';
import type { PersonalitiesService } from '../../services/personalities.service';

interface ModelsResponse {
  object: string;
  data: Array<{ id: string; object: string; created: number; owned_by: string }>;
}

function makeStubPersonalitiesService(ids: string[]): PersonalitiesService {
  return {
    list() {
      return {
        personalities: ids.map((id) => ({ id }) as never),
        defaultId: ids[0] ?? 'ethos',
      };
    },
  } as unknown as PersonalitiesService;
}

describe('GET /v1/models', () => {
  let store: SqliteApiKeyStore;
  let secret: string;

  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    const created = await store.create({ name: 'cursor', scopes: ['chat'] });
    secret = created.secret;
  });

  afterEach(() => {
    store.close();
  });

  it('returns OpenAI-shaped list of personalities + ethos-default with a valid key', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(['engineer', 'coordinator']),
    });
    const res = await app.request('/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    expect(body.object).toBe('list');
    const ids = body.data.map((m) => m.id);
    expect(ids).toEqual(['engineer', 'coordinator', 'ethos-default']);
    expect(body.data[0]).toEqual({
      id: 'engineer',
      object: 'model',
      created: 0,
      owned_by: 'ethos',
    });
  });

  it('includes team: entries when a listTeams callback is provided', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(['engineer']),
      listTeams: async () => ['analytics', 'support'],
    });
    const res = await app.request('/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    const ids = body.data.map((m) => m.id);
    expect(ids).toEqual(['engineer', 'team:analytics', 'team:support', 'ethos-default']);
  });

  it('returns 401 when Authorization is missing', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(['engineer']),
    });
    const res = await app.request('/models');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('returns 401 when the key has been revoked', async () => {
    const all = await store.list();
    const target = all[0];
    if (!target) throw new Error('expected one key');
    await store.revoke(target.prefix);
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(['engineer']),
    });
    const res = await app.request('/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(401);
  });
});
