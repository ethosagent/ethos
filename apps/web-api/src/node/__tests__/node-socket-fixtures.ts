// Shared harness for the node-socket*.test.ts files: a real `ws` server on an ephemeral port, a real
// SqliteApiKeyStore and the client helpers. The beforeEach/afterEach hooks register at import time,
// so each test file that imports this module gets a fresh store and (via `setup()`) server per test.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { encodeFrame, NODE_HOST_SCOPE, NodeHub } from '@ethosagent/wiring/nodes';
import { afterEach, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { NodePairing, type NodePairingOptions } from '../node-pairing';
import { createNodeSocket, type NodeSocket } from '../node-socket';

export const ROOTS = [{ path: '/proj', readOnly: false }];
export const hello = (name = 'spoofed') =>
  encodeFrame({
    v: 1,
    kind: 'hello',
    name,
    roots: ROOTS,
    tools: ['read_file'],
    personalities: ['*'],
    clock: Date.now(),
  });
export const pairRequest = (name: string) =>
  encodeFrame({ v: 1, kind: 'pair_request', name, roots: ROOTS });

export let dir: string;
export let server: Server;
export let store: SqliteApiKeyStore;
export let hub: NodeHub;
export let pairing: NodePairing;
export let sock: NodeSocket;
export let base: string;
export let nowMs: number;
/** Move the injected pairing clock forward (imports are read-only, so tests go through this). */
export function advanceClock(ms: number): void {
  nowMs += ms;
}

export async function setup(
  opts: {
    pairing?: Partial<NodePairingOptions>;
    helloTimeoutMs?: number;
    trustProxy?: boolean;
  } = {},
): Promise<void> {
  hub = new NodeHub();
  pairing = new NodePairing({ apiKeys: store, now: () => nowMs, ...opts.pairing });
  sock = createNodeSocket({
    hub,
    apiKeys: store,
    pairing,
    pingIntervalMs: 50,
    helloTimeoutMs: opts.helloTimeoutMs ?? 5_000,
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
  });
  server = createServer();
  sock.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-node-socket-'));
  store = new SqliteApiKeyStore(join(dir, 'sessions.db'));
  nowMs = 1_000_000;
});

afterEach(async () => {
  await sock?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

export type Conn = { ws: WebSocket; status?: undefined } | { ws?: undefined; status: number };

export function connect(path: string, headers: Record<string, string> = {}): Promise<Conn> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}${path}`, { headers });
    ws.on('open', () => resolve({ ws }));
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on('error', () => {
      // Refused upgrades surface through `unexpected-response`; a reset is covered by the status.
    });
  });
}

export async function open(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const c = await connect(path, headers);
  if (!c.ws) throw new Error(`upgrade refused: ${c.status}`);
  return c.ws;
}

export const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
export const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
export const message = (ws: WebSocket) =>
  new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())));

export async function until(pred: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not reached');
}

export async function nodeKey(name = 'node:laptop') {
  return store.create({ name, scopes: [NODE_HOST_SCOPE] });
}
