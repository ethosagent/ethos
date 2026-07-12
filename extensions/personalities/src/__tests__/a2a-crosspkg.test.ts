// Cross-package round-trip: a card SIGNED here (personalities `getIdentity` →
// `signCard`) must VERIFY through `@ethosagent/a2a`'s `verifyCard`, imported
// DIRECTLY from the package (not via the personalities re-export shim). This is
// the guard against canonicalization drift after re-homing the crypto to
// `packages/a2a` (plan §7, Phase 3): signer and verifier share ONE
// canonicalization, so if they ever diverge this test fails.

import { verifyCard } from '@ethosagent/a2a/crypto';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { PersonalityA2aIdentityProvider } from '../a2a-identity';
import { FilePersonalityRegistry } from '../index';

const ROOT = '/ethos/personalities';
const DIR = `${ROOT}/researcher`;

async function makeProvider(): Promise<PersonalityA2aIdentityProvider> {
  const storage = new InMemoryStorage();
  await storage.mkdir(DIR);
  await storage.write(
    `${DIR}/config.yaml`,
    ['name: Researcher', 'description: A careful researcher.'].join('\n'),
  );
  await storage.write(`${DIR}/SOUL.md`, '# Researcher\n\nI dig into questions.\n');
  await storage.write(`${DIR}/toolset.yaml`, '- web_search\n');
  const registry = new FilePersonalityRegistry(storage);
  await registry.loadFromDirectory(ROOT);
  return new PersonalityA2aIdentityProvider({
    personalities: registry,
    secrets: new InMemorySecretsResolver(),
    storage,
    baseUrl: 'https://agent.example',
  });
}

describe('A2A cross-package sign ↔ verify round-trip', () => {
  it('a personality-signed card verifies via @ethosagent/a2a verifyCard', async () => {
    const provider = await makeProvider();
    for (const audience of ['stranger', 'trusted-peer', 'internal'] as const) {
      const card = await provider.getIdentity('researcher', audience);
      expect(verifyCard(card)).toBe(true);
    }
  });

  it('rejects a personality-signed card whose body was tampered', async () => {
    const provider = await makeProvider();
    const card = await provider.getIdentity('researcher', 'stranger');
    expect(verifyCard({ ...card, name: 'Imposter' })).toBe(false);
  });
});
