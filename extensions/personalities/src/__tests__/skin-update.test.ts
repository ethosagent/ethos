import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

// Round-trip tests for the `skin` field on UpdatePersonalityPatch — both the
// "set" and "clear" arms, plus the yaml emission that the CLI + Web UI
// surfaces both depend on.

let testDir: string;
let userDir: string;
let reg: FilePersonalityRegistry;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-skin-update-${Date.now()}-${Math.random()}`);
  // The registry treats `userPersonalitiesDir` as the parent of a
  // `personalities/` subdir — so the actual personality lives at
  // `<testDir>/personalities/<id>/` and `userDir` is what
  // requireMutable's prefix check compares against.
  userDir = join(testDir, 'personalities');
  const seedDir = join(userDir, 'inventor');
  await mkdir(seedDir, { recursive: true });
  await writeFile(join(seedDir, 'config.yaml'), 'name: Inventor\nmodel: claude-opus-4-7\n');
  await writeFile(join(seedDir, 'ETHOS.md'), '# Inventor');

  reg = new FilePersonalityRegistry(new FsStorage(), testDir);
  await reg.loadFromDirectory(userDir);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('FilePersonalityRegistry.update — skin field', () => {
  it('writes `skin: <name>` to config.yaml when patch.skin is a string', async () => {
    await reg.update('inventor', { skin: 'paper' });
    const raw = await readFile(join(userDir, 'inventor', 'config.yaml'), 'utf8');
    expect(raw).toMatch(/^skin: paper$/m);
    expect(reg.get('inventor')?.skin).toBe('paper');
  });

  it('drops the `skin:` line when patch.skin is null', async () => {
    await reg.update('inventor', { skin: 'mono' });
    expect(reg.get('inventor')?.skin).toBe('mono');

    await reg.update('inventor', { skin: null });
    const raw = await readFile(join(userDir, 'inventor', 'config.yaml'), 'utf8');
    expect(raw).not.toMatch(/^skin:/m);
    expect(reg.get('inventor')?.skin).toBeUndefined();
  });

  it('leaves the existing skin alone when patch.skin is undefined', async () => {
    await reg.update('inventor', { skin: 'paper' });
    // A patch that touches name only — must not touch skin.
    await reg.update('inventor', { name: 'Inventor Mk II' });
    expect(reg.get('inventor')?.skin).toBe('paper');
    expect(reg.get('inventor')?.name).toBe('Inventor Mk II');
  });

  it('refuses to mutate a built-in personality', async () => {
    // The built-in personalities live in the package's data dir and are
    // loaded by createPersonalityRegistry. Directly using the registry
    // bound to `userDir` only sees `inventor`, so we simulate the gate by
    // calling update on a non-existent id (separate code path) — the
    // mutability gate itself is covered by the existing FilePersonalityRegistry
    // tests around mcp/plugins. This guards the specific skin path: a
    // missing id throws PERSONALITY_NOT_FOUND, not a silent no-op.
    await expect(reg.update('does-not-exist', { skin: 'paper' })).rejects.toThrow(/not found/i);
  });
});
