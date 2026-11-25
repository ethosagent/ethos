// Shared fixtures for the node-command-*.test.ts files: fake socket net, in-memory deps and the
// per-test reset hooks. Registered at import time, so each test file that imports this module
// gets a fresh storage, secrets and net before every test.

import { PassThrough } from 'node:stream';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import {
  encodeFrame,
  type NodeSocketFactory,
  type NodeSocketHandlers,
} from '@ethosagent/wiring/nodes';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { NodeCommandDeps } from '../commands/node';

export const SERVER = 'http://127.0.0.1:3000';
export const STATE_DIR = '/state';

export interface FakeSock {
  url: string;
  headers: Record<string, string> | undefined;
  h: NodeSocketHandlers;
  sent: string[];
}

/** Fake `ws`: pair sockets answer themselves; node sockets are driven by the test. */
export function makeNet(pairKey = 'sk-ethos-PAIREDKEY') {
  const sockets: FakeSock[] = [];
  const factory: NodeSocketFactory = (url, init, h) => {
    const s: FakeSock = { url, headers: init.headers, h, sent: [] };
    sockets.push(s);
    const isPair = url.endsWith('/node/pair');
    if (isPair) queueMicrotask(() => h.onOpen());
    return {
      send: (text) => {
        s.sent.push(text);
        if (isPair) {
          h.onText(encodeFrame({ v: 1, kind: 'pair_pending', code: 'ABCD2345', expiresAt: 1 }));
          h.onText(encodeFrame({ v: 1, kind: 'pair_approved', key: pairKey, keyId: 'id1' }));
        }
      },
      close: (code) => queueMicrotask(() => h.onClose(code ?? 1000, '')),
    };
  };
  return {
    sockets,
    factory,
    nodeSockets: () => sockets.filter((s) => s.url.endsWith('/node/ws')),
    pairSockets: () => sockets.filter((s) => s.url.endsWith('/node/pair')),
  };
}

export let storage: InMemoryStorage;
export let secrets: InMemorySecretsResolver;
export let out: string[];
export let err: string[];
export let stop: (() => Promise<void>) | undefined;
export let net: ReturnType<typeof makeNet>;
/** Replace the fake net mid-test (imports are read-only, so tests go through this). */
export function resetNet(pairKey?: string): void {
  net = makeNet(pairKey);
}

export function deps(over: Partial<NodeCommandDeps> = {}): Partial<NodeCommandDeps> {
  return {
    storage,
    secrets,
    stateDir: STATE_DIR,
    dataDir: STATE_DIR,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    socketFactory: net.factory,
    random: () => 1,
    webToken: async () => 'tok123',
    defaultServerUrl: async () => SERVER,
    onSignal: (s) => {
      stop = s;
    },
    ...over,
  };
}

export const text = (lines: string[]) => lines.join('');
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
export async function until(pred: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(pred()).toBe(true), { timeout: 2000, interval: 5 });
}
export async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof EthosError) return e.code;
    throw e;
  }
  return 'none';
}

beforeEach(async () => {
  storage = new InMemoryStorage();
  secrets = new InMemorySecretsResolver();
  out = [];
  err = [];
  stop = undefined;
  net = makeNet();
  await storage.mkdir('/work/a');
  await storage.mkdir('/work/b');
});
afterEach(() => {
  vi.useRealTimers();
});
