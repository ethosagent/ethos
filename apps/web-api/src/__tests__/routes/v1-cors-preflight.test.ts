// `/v1/*` CORS on the real boot path (`createWebApi` → `createRoutes`), not
// `openAiCors` in isolation. The app-wide credentialed policy
// (`allowedOrigins`, `ETHOS_ALLOWED_ORIGINS`) used to answer every preflight,
// `/v1` included, so an origin listed only in the `/v1` list
// (`corsOrigins`, `ETHOS_API_CORS_ORIGINS` > `web.corsOrigins`) failed the
// preflight every `/v1` call makes (it carries `Authorization`). The rule now:
// `/v1/*` answers from the `/v1` list only, uncredentialed; every other route
// answers from `allowedOrigins`, credentialed, exactly as before.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

const V1_ORIGIN = 'https://chat.example.com';
const APP_ORIGIN = 'https://dashboard.example.com';

describe('createWebApi — /v1 CORS preflight uses the /v1 origin list', () => {
  let dataDir: string;
  let sessionStore: SQLiteSessionStore;
  let apiKeys: SqliteApiKeyStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-v1-cors-'));
    sessionStore = new SQLiteSessionStore(':memory:');
    apiKeys = new SqliteApiKeyStore(':memory:');
  });

  afterEach(async () => {
    sessionStore.close();
    apiKeys.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function buildApp(corsOrigins: string) {
    return createWebApi({
      dataDir,
      sessionStore,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop({ events: [{ type: 'done', text: 'hi', turnCount: 1 }] }),
      personalities: makeStubPersonalityRegistry([
        { id: 'engineer', name: 'Engineer' } as PersonalityConfig,
      ]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys,
      allowedOrigins: [APP_ORIGIN],
      corsOrigins,
    }).app;
  }

  function preflight(app: ReturnType<typeof buildApp>, path: string, origin: string) {
    return app.request(path, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
  }

  it('allows a /v1 preflight from an origin in the /v1 list, with Authorization allowed', async () => {
    const res = await preflight(buildApp(V1_ORIGIN), '/v1/models', V1_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(V1_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'content-type',
    );
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('does not reflect an origin listed only in allowedOrigins on /v1', async () => {
    const res = await preflight(buildApp(V1_ORIGIN), '/v1/models', APP_ORIGIN);
    expect(res.headers.get('access-control-allow-origin')).toBeFalsy();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('answers `*` in the /v1 list with a wildcard and no credentials', async () => {
    const res = await preflight(buildApp('*'), '/v1/models', 'https://anywhere.example');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('leaves /rpc preflights on the credentialed allowedOrigins policy', async () => {
    const app = buildApp(V1_ORIGIN);

    const allowed = await preflight(app, '/rpc/sessions/list', APP_ORIGIN);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

    const v1Only = await preflight(app, '/rpc/sessions/list', V1_ORIGIN);
    expect(v1Only.headers.get('access-control-allow-origin')).toBeFalsy();
  });
});
