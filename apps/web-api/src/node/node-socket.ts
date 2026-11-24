/**
 * The `ws` half of the laptop-node lane (plan laptop-tool-node T7): `GET /node/ws` (a paired node's
 * session) and `GET /node/pair` (unauthenticated pairing request). Mounted on web-api through
 * `registerUpgradeRoute`, like the satellite lane. The hub owns call bookkeeping, `NodePairing`
 * owns pairing; this file owns the sockets, the upgrade policy and key re-validation.
 * Silent by design: it is app code with no injected Logger; eviction logging lives in NodeHub.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { EthosError, type Logger } from '@ethosagent/types';
import {
  decodeNodeFrame,
  decodePairClientFrame,
  encodeFrame,
  NODE_CLOSE,
  NODE_FRAME_MAX_BYTES,
  NODE_HOST_SCOPE,
  NODE_PAIR_PATH,
  NODE_SOCKET_PATH,
  type NodeHub,
  type PairClientFrame,
} from '@ethosagent/wiring/nodes';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { ApiKeyAuthStore, ApiKeyRecord } from '../middleware/bearer-auth';
import { hashBearerHeader, verifyBearer } from '../middleware/dual-auth';
import { clientKeyOf } from '../middleware/rate-limit';
import {
  refuseUpgrade,
  registerUpgradeRoute,
  type UpgradableServer,
} from '../voice/upgrade-router';
import type { NodePairing, PairConnection } from './node-pairing';

export interface NodeSocketOptions {
  hub: NodeHub;
  apiKeys: ApiKeyAuthStore;
  pairing: NodePairing;
  /** Ping + key re-validation cadence. Default 25_000 (plan §10 ingress idle timeouts). */
  pingIntervalMs?: number;
  /** How long a fresh socket may stay silent before it is closed 1008. Default 10_000. */
  helloTimeoutMs?: number;
  /** Honor `X-Forwarded-For` / `X-Real-IP` for the pairing bucket, like rateLimitMiddleware (ETHOS_TRUST_PROXY). */
  trustProxy?: boolean;
  logger?: Logger;
}

export interface NodeSocket {
  /** Serve both node paths on a listening server's upgrade router. */
  attach(server: UpgradableServer): void;
  close(): Promise<void>;
}

/** The key row is named `node:<name>` by pairing; that name, not the laptop's hello, labels the node. */
function displayName(record: ApiKeyRecord): string {
  return record.name.startsWith('node:') ? record.name.slice('node:'.length) : record.name;
}

function text(data: RawData, isBinary: boolean): string | null {
  if (isBinary) return null;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export function createNodeSocket(opts: NodeSocketOptions): NodeSocket {
  const { hub, apiKeys, pairing } = opts;
  const pingIntervalMs = opts.pingIntervalMs ?? 25_000;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
  const trustProxy = opts.trustProxy ?? false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: NODE_FRAME_MAX_BYTES });
  const lastTouchAt = new Map<string, number>();
  const live = new Set<WebSocket>();
  const detachers: Array<() => void> = [];

  function onNodeSocket(ws: WebSocket, record: ApiKeyRecord, hash: string | null): void {
    live.add(ws);
    let session: ReturnType<NodeHub['attach']> | undefined;
    let revoked = false;
    const helloTimer = setTimeout(
      () => ws.close(NODE_CLOSE.badFrame, 'hello timeout'),
      helloTimeoutMs,
    );
    // Verification B4: a revoked key must drop a LIVE socket. Revocation happens in another process
    // (`ethos node revoke`), so every ping tick re-reads the key row. Pinned by node-socket.test.ts.
    const ticker = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(encodeFrame({ v: 1, kind: 'ping', at: Date.now() }));
      if (hash === null) return;
      apiKeys
        .findByHash(hash)
        .then((rec) => {
          if (!rec || rec.revokedAt) {
            revoked = true;
            ws.close(NODE_CLOSE.revoked, 'key revoked');
          }
        })
        .catch(() => {
          // A failed lookup says nothing about the key; the next tick asks again.
        });
    }, pingIntervalMs);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const raw = text(data, isBinary);
      if (raw === null) {
        ws.close(NODE_CLOSE.badFrame, 'text frames only');
        return;
      }
      const decoded = decodeNodeFrame(raw);
      if (!decoded.ok) {
        ws.close(NODE_CLOSE.badFrame, 'bad frame');
        return;
      }
      if (!session) {
        if (decoded.frame.kind !== 'hello') {
          ws.close(NODE_CLOSE.badFrame, 'hello first');
          return;
        }
        clearTimeout(helloTimer);
        session = hub.attach(
          record.id,
          { ...decoded.frame, name: displayName(record) },
          {
            send: (f) => ws.send(encodeFrame(f)),
            close: (code, reason) => ws.close(code, reason),
          },
        );
        return;
      }
      session.receive(decoded.frame);
    });
    const end = (): void => {
      clearTimeout(helloTimer);
      clearInterval(ticker);
      live.delete(ws);
      session?.detach();
      // A revoked key never returns: drop its offline entry so a re-pair of the name is not ambiguous.
      if (revoked) hub.forget(record.id);
    };
    ws.on('close', end);
    ws.on('error', end);
  }

  function pairConnection(ws: WebSocket): PairConnection {
    live.add(ws);
    let onFrame: (f: PairClientFrame) => void = () => {};
    let onClose: () => void = () => {};
    // A socket that never asks must not linger (same budget as the hello timeout).
    const timer = setTimeout(
      () => ws.close(NODE_CLOSE.badFrame, 'pair request timeout'),
      helloTimeoutMs,
    );
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const raw = text(data, isBinary);
      const decoded = raw === null ? null : decodePairClientFrame(raw);
      if (!decoded?.ok) {
        ws.close(NODE_CLOSE.badFrame, 'bad frame');
        return;
      }
      clearTimeout(timer);
      onFrame(decoded.frame);
    });
    // Ingress idle timeouts (plan §10) also cut a pending socket; a protocol ping keeps it open
    // while the operator walks to the server. Cleared on close; approve closes the socket.
    const pinger = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, pingIntervalMs);
    const end = (): void => {
      clearTimeout(timer);
      clearInterval(pinger);
      live.delete(ws);
      onClose();
    };
    ws.on('close', end);
    ws.on('error', end);
    return {
      send: (f) => ws.send(encodeFrame(f)),
      close: (code, reason) => ws.close(code, reason),
      isOpen: () => ws.readyState === ws.OPEN,
      onFrame: (cb) => {
        onFrame = cb;
      },
      onClose: (cb) => {
        onClose = cb;
      },
    };
  }

  // No Origin rule on this lane: a browser cannot set `Authorization` on a WebSocket (same reasoning
  // as the mobile-app lane); the key's own `allowedOrigins` still applies inside verifyBearer.
  const handleNodeUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const header = req.headers.authorization;
    if (!header) {
      refuseUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    verifyBearer({
      header,
      origin: req.headers.origin,
      apiKeys,
      requiredScope: NODE_HOST_SCOPE,
      lastTouchAt,
    })
      .then((record) => {
        // Only the hash outlives the upgrade: the live socket re-reads the key row by it.
        const hash = hashBearerHeader(header);
        wss.handleUpgrade(req, socket, head, (ws) => onNodeSocket(ws, record, hash));
      })
      .catch((err: unknown) => {
        if (err instanceof EthosError && err.code === 'FORBIDDEN') {
          refuseUpgrade(socket, 403, 'Forbidden');
        } else {
          refuseUpgrade(socket, 401, 'Unauthorized');
        }
      });
  };

  const handlePairUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const ip = clientKeyOf(
      {
        forwardedFor: header('x-forwarded-for'),
        realIp: header('x-real-ip'),
        remoteAddress: req.socket.remoteAddress,
      },
      trustProxy,
    );
    if (!pairing.canAccept(ip)) {
      refuseUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => pairing.open(pairConnection(ws)));
  };

  return {
    attach(server: UpgradableServer): void {
      for (const d of detachers.splice(0)) d();
      detachers.push(
        registerUpgradeRoute(server, NODE_SOCKET_PATH, handleNodeUpgrade),
        registerUpgradeRoute(server, NODE_PAIR_PATH, handlePairUpgrade),
      );
    },
    close(): Promise<void> {
      for (const d of detachers.splice(0)) d();
      pairing.close();
      for (const ws of live) ws.close(1001, 'server closing');
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
