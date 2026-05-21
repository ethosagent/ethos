// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${self}` / `${ETHOS_HOME}` / `${CWD}` tokens — not template interpolation.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-roundtrip-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function seedPersonality(
  id: string,
  config: string,
  soulMd = `# ${id}\n\nIdentity text.\n`,
  toolset = '- read_file\n',
): Promise<void> {
  const dir = join(testDir, 'personalities', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), config);
  await writeFile(join(dir, 'SOUL.md'), soulMd);
  await writeFile(join(dir, 'toolset.yaml'), toolset);
}

function makeRegistry(): FilePersonalityRegistry {
  return new FilePersonalityRegistry(undefined, testDir);
}

describe('capabilities round-trip', () => {
  it('persists capabilities through update and re-load', async () => {
    await seedPersonality('cap-test', 'name: CapTest\ndescription: Testing caps\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('cap-test', { capabilities: ['triage', 'release'] });

    // Re-load into a fresh registry to verify persistence
    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('cap-test');
    expect(config).toBeDefined();
    expect(config?.capabilities).toEqual(['triage', 'release']);
  });

  it('writes comma-separated capabilities to config.yaml', async () => {
    await seedPersonality('cap-yaml', 'name: CapYaml\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('cap-yaml', { capabilities: ['triage', 'release'] });

    const raw = await readFile(join(testDir, 'personalities', 'cap-yaml', 'config.yaml'), 'utf-8');
    expect(raw).toContain('capabilities: triage, release');
  });
});

describe('provider round-trip', () => {
  it('persists provider: openai through update and re-load', async () => {
    await seedPersonality('prov-openai', 'name: ProvOpenai\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('prov-openai', { provider: 'openai' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('prov-openai')?.provider).toBe('openai');
  });

  it('persists provider: azure through update and re-load', async () => {
    await seedPersonality('prov-azure', 'name: ProvAzure\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('prov-azure', { provider: 'azure' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('prov-azure')?.provider).toBe('azure');
  });

  it('clears provider when updated with empty string', async () => {
    await seedPersonality('prov-clear', 'name: ProvClear\nprovider: openai\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('prov-clear')?.provider).toBe('openai');

    await registry.update('prov-clear', { provider: '' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    // Empty string is treated as falsy by the loader — provider should be undefined
    expect(fresh.get('prov-clear')?.provider).toBeUndefined();
  });
});

describe('fs_reach round-trip', () => {
  it('persists fs_reach through update and re-load', async () => {
    await seedPersonality('reach-test', 'name: ReachTest\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('reach-test', {
      fs_reach: { read: ['/data', '${self}/docs'], write: ['/data/output'] },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('reach-test');
    expect(config?.fs_reach?.read).toEqual(['/data', '${self}/docs']);
    expect(config?.fs_reach?.write).toEqual(['/data/output']);
  });

  it('writes dotted fs_reach keys to config.yaml', async () => {
    await seedPersonality('reach-yaml', 'name: ReachYaml\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('reach-yaml', {
      fs_reach: { read: ['/data', '${self}/docs'], write: ['/data/output'] },
    });

    const raw = await readFile(
      join(testDir, 'personalities', 'reach-yaml', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('fs_reach.read: /data, ${self}/docs');
    expect(raw).toContain('fs_reach.write: /data/output');
  });
});
