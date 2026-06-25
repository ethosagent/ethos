import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';

export interface WebhookConfig {
  personalityId: string;
  secret: string;
  sessionKey?: string;
}

/**
 * Minimal slice of the Gateway this server drives. Kept local — and the
 * capturing-adapter factory is injected — so this file imports only
 * `@ethosagent/types`. That keeps the `@ethosagent/gateway` import confined to
 * `commands/gateway.ts` (the daemon-free doctrine, `daemon-free-smoke.test.ts`):
 * no top-level feature may pull in the gateway package.
 */
export interface WebhookGateway {
  handleMessage(message: InboundMessage, adapter: PlatformAdapter): Promise<void>;
}

/** Per-request response-capturing adapter — supplied by the gateway command,
 *  which owns the only `@ethosagent/gateway` import. */
export type CaptureFactory = () => { adapter: PlatformAdapter; getReply(): string };

// Module-level counter so repeated requests get distinct messageIds and the
// gateway's inbound dedup never drops a legitimate repeated call.
let requestCounter = 0;

const WEBHOOK_PATH = /^\/webhook\/([^/]+)$/;

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Constant-time bearer check. Guards length first — `timingSafeEqual` throws
 *  on mismatched buffer lengths. */
function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Inbound webhook listener. Exposes `POST /webhook/<hookId>`: an external caller
 * supplies a bearer secret and a prompt; the handler synthesizes an
 * `InboundMessage` and drives the mapped personality through the existing
 * `Gateway.handleMessage` path, returning the agent's reply synchronously.
 */
export function createWebhookServer(
  port: number,
  host: string,
  gateway: WebhookGateway,
  webhooks: Record<string, WebhookConfig>,
  createCapturingAdapter: CaptureFactory,
): Server {
  const server = createServer(async (req, res) => {
    const match = req.url ? WEBHOOK_PATH.exec(req.url) : null;
    if (req.method !== 'POST' || !match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const hookId = match[1];
    const hook = webhooks[hookId];
    if (!hook) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!authorized(req.headers.authorization, hook.secret)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    let body: { prompt?: string; text?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    // TODO v2: attachments
    const prompt = body.prompt ?? body.text;
    if (!prompt || prompt.trim().length === 0) {
      sendJson(res, 400, { error: "missing 'prompt'" });
      return;
    }

    const msg: InboundMessage = {
      platform: 'webhook',
      chatId: hook.sessionKey ?? hookId,
      text: prompt,
      isDm: true,
      isGroupMention: false,
      botKey: `webhook:${hookId}`,
      messageId: `${Date.now()}-${requestCounter++}`,
      raw: body,
    };

    const { adapter, getReply } = createCapturingAdapter();
    // Per-request read so tests (and operators) can override the timeout at
    // runtime, not just at module load.
    const timeoutMs = Number(process.env.ETHOS_WEBHOOK_TIMEOUT_MS) || 60_000;

    let timer: NodeJS.Timeout | undefined;
    let responded = false;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const result = await Promise.race([
        gateway.handleMessage(msg, adapter).then(() => 'done' as const),
        timeout,
      ]);
      responded = true;
      if (result === 'timeout') {
        sendJson(res, 504, { error: 'timeout' });
      } else {
        sendJson(res, 200, { reply: getReply() });
      }
    } catch (err) {
      if (!responded) {
        console.error('[webhook] handler error:', err);
        sendJson(res, 500, { error: 'internal error' });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[webhook] port ${port} in use — webhook endpoint unavailable. ` +
          'Set ETHOS_WEBHOOK_PORT to change.',
      );
    }
  });
  server.listen(port, host);
  server.unref();
  return server;
}
