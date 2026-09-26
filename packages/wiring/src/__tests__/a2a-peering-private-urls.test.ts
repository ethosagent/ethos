// Operator-initiated peering vs the S7 egress policy. `ethos a2a peer add` and
// the web "Add peer" dialog fetch a card from a URL the OPERATOR typed, so the
// policy that governs them is the operator's `a2a.peering.allowPrivateUrls`,
// not a personality's `safety.network` (that one still governs the
// model-driven `a2a_send`). Exercised against a real loopback HTTP server with
// the real `fetchAndVerifyCard` → `safeFetch` path — no fetch stub.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StorageA2aAllowlist, StorageA2aPeerStore } from '@ethosagent/a2a';
import { buildDidDocument, fingerprint, generateEd25519, signCard } from '@ethosagent/a2a/crypto';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { A2aIdentityProvider, AgentCard } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A2aPeeringService, buildA2aPeeringService } from '../a2a-peering-service';

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

const noIdentity: A2aIdentityProvider = {
  async getIdentity() {
    throw new Error('not used');
  },
};

function service(allowPrivateUrls?: boolean): A2aPeeringService {
  return buildA2aPeeringService({
    storage: new InMemoryStorage(),
    baseDir: '/ethos/a2a',
    identity: noIdentity,
    ...(allowPrivateUrls !== undefined ? { allowPrivateUrls } : {}),
  });
}

const card = signedCard();
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(card));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/.well-known/agent-card.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('A2aPeeringService — operator peering policy (a2a.peering.allowPrivateUrls)', () => {
  it('reaches a loopback peer when the operator opts in', async () => {
    const preview = await service(true).previewPeer(url);
    expect(preview.fingerprint).toBe(card.keyFingerprint);
    expect(preview.card.name).toBe('Local Researcher');
  });

  it('adds a loopback peer when the operator opts in', async () => {
    const storage = new InMemoryStorage();
    const svc = new A2aPeeringService({
      identity: noIdentity,
      allowlist: new StorageA2aAllowlist(storage, '/a2a'),
      peers: new StorageA2aPeerStore(storage, '/a2a'),
      allowPrivateUrls: true,
    });
    const row = await svc.addPeer('p', { url, expectedFingerprint: card.keyFingerprint });
    expect(row.fingerprint).toBe(card.keyFingerprint);
  });

  it('refuses a loopback peer by default with url_refused naming the operator key', async () => {
    const err = await service()
      .previewPeer(url)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'url_refused' });
    const message = (err as Error).message;
    expect(message).toContain('a2a.peering.allowPrivateUrls');
    expect(message).not.toContain('safety.network');
  });

  it('refuses the cloud-metadata address even with the opt-in', async () => {
    const err = await service(true)
      .previewPeer('http://169.254.169.254/.well-known/agent-card.json')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'url_refused' });
  });
});
