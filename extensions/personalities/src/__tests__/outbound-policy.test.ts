import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry, OUTBOUND_POLICY_PLATFORMS } from '../index';

// `PersonalityConfig.outbound_policy` — the loader half of the approval outbox
// (O-T11). `channels` names the platforms the gate applies to, and a name that
// matches no platform is the dangerous typo: the gate would never fire and the
// personality would publish freely from a config that reads as if it were held
// back. So the load FAILS, the way an unknown `execution` requirement does.

const DATA = '/data';
const DIR = join(DATA, 'personalities');

async function seed(storage: Storage, id: string, config: string): Promise<void> {
  const dir = join(DIR, id);
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), config);
  await storage.write(join(dir, 'SOUL.md'), `# ${id}\n`);
  await storage.write(join(dir, 'toolset.yaml'), '- send_message\n');
}

describe('outbound_policy.channels — loader validation', () => {
  let storage: InMemoryStorage;
  let registry: FilePersonalityRegistry;

  beforeEach(() => {
    storage = new InMemoryStorage();
    registry = new FilePersonalityRegistry(storage, DATA);
  });

  it.each([...OUTBOUND_POLICY_PLATFORMS])('accepts %s', async (platform) => {
    await seed(
      storage,
      'cmo',
      `name: CMO\noutbound_policy.approve_before_send: true\noutbound_policy.channels: ${platform}\n`,
    );
    await registry.loadFromDirectory(DIR);
    expect(registry.get('cmo')?.outbound_policy?.channels).toEqual([platform]);
  });

  it('accepts a whitespace-separated list of known platforms', async () => {
    await seed(
      storage,
      'cmo',
      'name: CMO\noutbound_policy.approve_before_send: true\noutbound_policy.channels: telegram slack\n',
    );
    await registry.loadFromDirectory(DIR);
    expect(registry.get('cmo')?.outbound_policy?.channels).toEqual(['telegram', 'slack']);
  });

  it('fails the load on an unknown platform, naming the offending value', async () => {
    await seed(
      storage,
      'cmo',
      'name: CMO\noutbound_policy.approve_before_send: true\noutbound_policy.channels: telgram\n',
    );
    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(
      /Invalid outbound_policy\.channels: "telgram"\. Expected one of: slack, telegram, discord, whatsapp, email\./,
    );
  });

  it('names the offending value, not just the first entry in the list', async () => {
    await seed(
      storage,
      'cmo',
      'name: CMO\noutbound_policy.approve_before_send: true\noutbound_policy.channels: telegram signal\n',
    );
    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(
      /Invalid outbound_policy\.channels: "signal"/,
    );
  });

  // A `false` today is a `true` after one edit, and the typo would still be
  // sitting there — so validation does not wait for the policy to be armed.
  it('validates channels even when approve_before_send is false', async () => {
    await seed(
      storage,
      'cmo',
      'name: CMO\noutbound_policy.approve_before_send: false\noutbound_policy.channels: signal\n',
    );
    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(
      /Invalid outbound_policy\.channels: "signal"/,
    );
  });

  it('leaves channels absent when the key is not declared', async () => {
    await seed(storage, 'cmo', 'name: CMO\noutbound_policy.approve_before_send: true\n');
    await registry.loadFromDirectory(DIR);
    const policy = registry.get('cmo')?.outbound_policy;
    expect(policy?.approve_before_send).toBe(true);
    expect(policy?.channels).toBeUndefined();
  });
});
