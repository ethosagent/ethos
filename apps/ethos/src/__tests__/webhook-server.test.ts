import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCapturingAdapter } from '@ethosagent/gateway';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebhookServer, type WebhookGateway } from '../webhook-server';

const webhooks = { hook1: { personalityId: 'researcher', secret: 's3cret' } };

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function start(gateway: WebhookGateway): Promise<number> {
  return new Promise((resolve) => {
    const s = createWebhookServer(0, '127.0.0.1', gateway, webhooks, createCapturingAdapter);
    server = s;
    s.once('listening', () => {
      const addr = s.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function post(
  port: number,
  path: string,
  body: string,
  auth?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body }).then(
    async (res) => ({ status: res.status, body: await res.text() }),
  );
}

// Echoing gateway — drives the capturing adapter the same way handleMessage does.
const echoGateway: WebhookGateway = {
  handleMessage: async (_msg: InboundMessage, adapter: PlatformAdapter) => {
    await adapter.send('chat', { text: 'hello from agent' });
  },
};

describe('createWebhookServer', () => {
  it('200 + reply for a valid request', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'hello from agent' });
  });

  it('401 for a bad secret', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer wrong',
    );
    expect(res.status).toBe(401);
  });

  it('401 for a missing secret', async () => {
    const port = await start(echoGateway);
    const res = await post(port, '/webhook/hook1', JSON.stringify({ prompt: 'hi' }));
    expect(res.status).toBe(401);
  });

  it('404 for an unknown hookId', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/nope',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(404);
  });

  it('400 for an empty prompt', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: '  ' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(400);
  });

  it('400 for a malformed body shape (prompt not a string)', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 123 }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(400);
  });

  it('504 when the gateway never resolves', async () => {
    const prev = process.env.ETHOS_WEBHOOK_TIMEOUT_MS;
    process.env.ETHOS_WEBHOOK_TIMEOUT_MS = '50';
    const hangGateway: WebhookGateway = {
      handleMessage: () => new Promise<void>(() => {}),
    };
    try {
      const port = await start(hangGateway);
      const res = await post(
        port,
        '/webhook/hook1',
        JSON.stringify({ prompt: 'hi' }),
        'Bearer s3cret',
      );
      expect(res.status).toBe(504);
    } finally {
      if (prev === undefined) delete process.env.ETHOS_WEBHOOK_TIMEOUT_MS;
      else process.env.ETHOS_WEBHOOK_TIMEOUT_MS = prev;
    }
  });
});
