import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { verifyCard } from '../a2a-crypto';
import { PersonalityA2aIdentityProvider } from '../a2a-identity';
import { FilePersonalityRegistry } from '../index';

const ROOT = '/ethos/personalities';
const DIR = `${ROOT}/researcher`;

async function seedPersonality(storage: InMemoryStorage): Promise<void> {
  await storage.mkdir(DIR);
  await storage.write(
    `${DIR}/config.yaml`,
    ['name: Researcher', 'description: A careful researcher.'].join('\n'),
  );
  await storage.write(`${DIR}/SOUL.md`, '# Researcher\n\nI dig into questions and cite sources.\n');
  await storage.write(`${DIR}/toolset.yaml`, '- web_search\n');

  // Two skills: one exposed to agents, one private (no flag).
  await storage.mkdir(`${DIR}/skills/web-research`);
  await storage.write(
    `${DIR}/skills/web-research/SKILL.md`,
    [
      '---',
      'name: web-research',
      'description: Search the web and synthesize sources.',
      'ethos:',
      '  exposeToAgents: true',
      '---',
      'Body of the web-research skill.',
    ].join('\n'),
  );
  await storage.mkdir(`${DIR}/skills/internal-notes`);
  await storage.write(
    `${DIR}/skills/internal-notes/SKILL.md`,
    [
      '---',
      'name: internal-notes',
      'description: Private scratchpad conventions.',
      '---',
      'Body of the internal-notes skill.',
    ].join('\n'),
  );
}

async function makeProvider(): Promise<{
  provider: PersonalityA2aIdentityProvider;
  secrets: InMemorySecretsResolver;
  registry: FilePersonalityRegistry;
}> {
  const storage = new InMemoryStorage();
  await seedPersonality(storage);
  const registry = new FilePersonalityRegistry(storage);
  await registry.loadFromDirectory(ROOT);
  const secrets = new InMemorySecretsResolver();
  const provider = new PersonalityA2aIdentityProvider({
    personalities: registry,
    secrets,
    storage,
    baseUrl: 'https://agent.example',
  });
  return { provider, secrets, registry };
}

describe('PersonalityA2aIdentityProvider.getIdentity', () => {
  it('internal audience returns all of the personality skills', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'internal');
    expect(card.skills.map((s) => s.name).sort()).toEqual(['internal-notes', 'web-research']);
  });

  it('trusted-peer audience returns only exposeToAgents skills', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'trusted-peer');
    expect(card.skills.map((s) => s.name)).toEqual(['web-research']);
    expect(card.skills[0]?.description).toBe('Search the web and synthesize sources.');
  });

  it('default skill visibility is private (unflagged skill never leaks)', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'trusted-peer');
    expect(card.skills.some((s) => s.name === 'internal-notes')).toBe(false);
  });

  it('stranger audience returns a minimal card with no skill list', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'stranger');
    expect(card.skills).toEqual([]);
    expect(card.name).toBe('Researcher');
    expect(card.description).toBe('A careful researcher.');
  });

  it('produces a card that verifies (fingerprint + signature)', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'trusted-peer');
    expect(verifyCard(card)).toBe(true);
    expect(card.signatureAlg).toBe('ed25519');
    expect(card.protocolVersion).toBe('a2a/0.1');
  });

  it('carries endpoints and a DID envelope wired to the JSON-RPC endpoint', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'internal');
    expect(card.endpoints.jsonRpc).toBe('https://agent.example/a2a/researcher');
    expect(card.endpoints.auth).toBe('https://agent.example/a2a-auth/researcher');
    expect(card.did.id.startsWith('did:key:z6Mk')).toBe(true);
    expect(card.did.service[0]?.serviceEndpoint).toBe('https://agent.example/a2a/researcher');
  });

  it('generates the key once and reuses it across calls (stable identity)', async () => {
    const { provider, secrets } = await makeProvider();
    const first = await provider.getIdentity('researcher', 'internal');
    const second = await provider.getIdentity('researcher', 'stranger');
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.keyFingerprint).toBe(first.keyFingerprint);
    expect(await secrets.list('a2a/researcher/')).toEqual(['a2a/researcher/private-key']);
  });

  it('who-are-you parity: card name/description come from the same config + SOUL source', async () => {
    const { provider, registry } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'stranger');
    const config = registry.get('researcher');
    // Same source renderCharacterSheet() reads — config.name and the SOUL/description headline.
    expect(card.name).toBe(config?.name);
    expect(card.description).toBe(config?.description);
  });

  it('throws for an unknown personality', async () => {
    const { provider } = await makeProvider();
    await expect(provider.getIdentity('nope', 'internal')).rejects.toThrow(/not found/i);
  });
});
