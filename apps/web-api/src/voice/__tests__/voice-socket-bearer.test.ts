import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { VOICE_SOCKET_PATH } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import { createVoiceSocket, type VoiceSocket } from '../voice-socket';
import { voiceUpgradeAuthenticator } from '../voice-upgrade-auth';

// Mobile-app S8: the phone opens the voice socket with a bearer API key. The
// real authenticator (`voiceUpgradeAuthenticator` → `verifyBearer`) against a
// real key store and web-token file, over a real `ws` upgrade. The cookie
// cases pin that the browser path is unchanged.

describe('voice socket upgrade — bearer API key', () => {
  let server: Server;
  let voiceSocket: VoiceSocket;
  let store: SqliteApiKeyStore;
  let cookieToken: string;
  let port: number;

  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'ethos-voice-bearer-'));
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    cookieToken = await tokens.getOrCreate();
    server = createServer((_req, res) => res.end('ok'));
    voiceSocket = createVoiceSocket({
      authenticate: voiceUpgradeAuthenticator({ tokens, apiKeys: store }),
    });
    voiceSocket.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await voiceSocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  async function key(scopes: string[], allowedOrigins?: string[]) {
    return store.create({
      name: 'phone',
      scopes,
      ...(allowedOrigins ? { allowedOrigins } : {}),
    });
  }

  /** The upgrade's HTTP status: 101 when the socket opened. */
  function upgradeStatus(headers: Record<string, string>): Promise<number> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICE_SOCKET_PATH}`, { headers });
    return new Promise<number>((resolve) => {
      ws.on('upgrade', () => {
        resolve(101);
        ws.close();
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
  }

  it('opens for a bearer holding voice:talk', async () => {
    const { secret } = await key(['voice:talk']);
    expect(await upgradeStatus({ authorization: `Bearer ${secret}` })).toBe(101);
  });

  it("opens for a bearer from a phone's LAN Origin (the loopback rule is skipped)", async () => {
    const { secret } = await key(['voice:talk']);
    expect(
      await upgradeStatus({
        authorization: `Bearer ${secret}`,
        origin: 'http://192.168.1.20:3000',
      }),
    ).toBe(101);
  });

  it('refuses a bearer without voice:talk with 403', async () => {
    const { secret } = await key(['chat:send']);
    expect(await upgradeStatus({ authorization: `Bearer ${secret}` })).toBe(403);
  });

  it('refuses an unknown or a revoked key with 401', async () => {
    expect(await upgradeStatus({ authorization: 'Bearer sk-ethos-unknown' })).toBe(401);
    const { secret, record } = await key(['voice:talk']);
    await store.revoke(record.prefix);
    expect(await upgradeStatus({ authorization: `Bearer ${secret}` })).toBe(401);
  });

  it('refuses a key whose allowedOrigins does not match with 403', async () => {
    const { secret } = await key(['voice:talk'], ['https://mc.example']);
    expect(
      await upgradeStatus({
        authorization: `Bearer ${secret}`,
        origin: 'http://192.168.1.20:3000',
      }),
    ).toBe(403);
  });

  it('refuses a request with no credential with 401', async () => {
    expect(await upgradeStatus({})).toBe(401);
  });

  it('takes the bearer path exclusively: a bad bearer beside a good cookie is 401', async () => {
    expect(
      await upgradeStatus({
        authorization: 'Bearer sk-ethos-unknown',
        cookie: `ethos_auth=${cookieToken}`,
        origin: 'http://192.168.1.20:3000',
      }),
    ).toBe(401);
  });

  it('opens for the cookie from a same-origin localhost page (unchanged)', async () => {
    expect(
      await upgradeStatus({
        cookie: `ethos_auth=${cookieToken}`,
        origin: `http://127.0.0.1:${port}`,
      }),
    ).toBe(101);
  });

  it('refuses the cookie from a localhost page on another port with 403 (unchanged)', async () => {
    expect(
      await upgradeStatus({
        cookie: `ethos_auth=${cookieToken}`,
        origin: `http://127.0.0.1:${port + 1}`,
      }),
    ).toBe(403);
  });
});
