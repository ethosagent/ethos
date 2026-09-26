// `ethos a2a peer add` against a peer on this machine, end to end: the real
// `runA2a` entry point (config read from ETHOS_STATE_DIR, the real
// A2aPeeringService, the real `fetchAndVerifyCard` → `safeFetch`) and a real
// loopback HTTP server serving a signed card. The operator's
// `a2a.peering.allowPrivateUrls` decides — not any personality's
// `safety.network`, which governs only the model-driven `a2a_send`.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDidDocument, fingerprint, generateEd25519, signCard } from '@ethosagent/a2a/crypto';
import type { AgentCard } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runA2a } from '../a2a';

function signedCard(): AgentCard {
  const { privateKeyPem, rawPublicKey } = generateEd25519();
  const jsonRpc = 'http://127.0.0.1/a2a/researcher';
  const unsigned: Omit<AgentCard, 'signature'> = {
    id: 'researcher',
    name: 'Local Researcher',
    description: 'A peer on this machine.',
    protocolVersion: 'a2a/0.1',
    skills: [],
    endpoints: { jsonRpc, auth: 'http://127.0.0.1/a2a-auth/researcher' },
    publicKey: rawPublicKey.toString('base64'),
    keyFingerprint: fingerprint(rawPublicKey),
    signatureAlg: 'ed25519',
    did: buildDidDocument(rawPublicKey, jsonRpc),
  };
  return { ...unsigned, signature: signCard(unsigned, privateKeyPem) };
}

const card = signedCard();
let server: Server;
let url: string;
let stateDir: string;
const prevStateDir = process.env.ETHOS_STATE_DIR;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function writeConfig(...extra: string[]): void {
  writeFileSync(
    join(stateDir, 'config.yaml'),
    ['provider: anthropic', 'model: claude-sonnet-5', 'apiKey: sk-test', ...extra].join('\n'),
  );
}

const printed = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(card));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/.well-known/agent-card.json`;
  stateDir = mkdtempSync(join(tmpdir(), 'ethos-a2a-peer-'));
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(stateDir, { recursive: true, force: true });
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
});

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('ethos a2a peer add — a peer on localhost', () => {
  it('previews the loopback peer when the operator set a2a.peering.allowPrivateUrls', async () => {
    writeConfig('a2a.peering.allowPrivateUrls: true');
    await runA2a(['peer', 'add', '--url', url]);
    expect(printed(errSpy)).toBe('');
    expect(printed(logSpy)).toContain(card.keyFingerprint);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses it by default and names the operator key, not safety.network', async () => {
    writeConfig();
    await runA2a(['peer', 'add', '--url', url]);
    const err = printed(errSpy);
    expect(err).toContain('a2a.peering.allowPrivateUrls');
    expect(err).not.toContain('safety.network');
    expect(process.exitCode).toBe(1);
  });
});
