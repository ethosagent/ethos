import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePersonalityRegistry, renderCharacterSheet } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-diff-${Date.now()}-${randomBytes(4).toString('hex')}`);
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
  return new FilePersonalityRegistry(new FsStorage(), testDir);
}

describe('personality diff', () => {
  it('produces identical sheets for same config rendered twice', async () => {
    await seedPersonality('alpha', 'name: Alpha\ndescription: Same thing\n');

    const reg = makeRegistry();
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    const desc = reg.describe('alpha');
    expect(desc).not.toBeNull();
    if (!desc) return;

    const soul = await reg.readSoulMd('alpha');
    const sheetA = renderCharacterSheet(desc.config, soul);
    const sheetB = renderCharacterSheet(desc.config, soul);
    expect(sheetA).toBe(sheetB);
  });

  it('detects differences between two distinct personalities', async () => {
    await seedPersonality(
      'engineer',
      'name: Engineer\ndescription: Writes code\nmodel: claude-sonnet-4-6\n',
      '# Engineer\n\nI write working code.\n',
      '- read_file\n- write_file\n- terminal\n',
    );
    await seedPersonality(
      'researcher',
      'name: Researcher\ndescription: Deep analysis\nmodel: claude-opus-4\n',
      '# Researcher\n\nI analyze problems deeply.\n',
      '- read_file\n- web_search\n',
    );

    const reg = makeRegistry();
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    const descA = reg.describe('engineer');
    const descB = reg.describe('researcher');
    expect(descA).not.toBeNull();
    expect(descB).not.toBeNull();
    if (!descA || !descB) return;

    const soulA = await reg.readSoulMd('engineer');
    const soulB = await reg.readSoulMd('researcher');

    const sheetA = renderCharacterSheet(descA.config, soulA);
    const sheetB = renderCharacterSheet(descB.config, soulB);

    expect(sheetA).not.toBe(sheetB);
    expect(sheetA).toContain('engineer');
    expect(sheetB).toContain('researcher');
  });

  it('returns null for unknown personality id', async () => {
    await seedPersonality('alpha', 'name: Alpha\n');

    const reg = makeRegistry();
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    const desc = reg.describe('nonexistent');
    expect(desc).toBeNull();
  });
});
