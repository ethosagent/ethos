// plan personality-presence-and-initiative §1 — `ethos personality create` is
// an operator create path, so what it makes is BORN, the same as the web
// create form (`PersonalitiesService.createBorn`): a birth marker under
// `learning/birth/` and `propose_self_amendment` in its declared toolset.
//
// - `--blank` goes through `FilePersonalityRegistry.create(…, { birth: true })`.
// - `--from` duplicates, then `markPersonalityBorn`.
// - the AI-assisted path: the personality-architect's `scaffold_personality`
//   writes the files (bounded by D13 — it can grant only tools the architect
//   holds), and the COMMAND, after the chat, marks each personality that
//   appeared during it with `markPersonalityBorn`. The filing tool comes from
//   the operator's command, never from the architect.
// Recipe installs are not a create path here and stay unborn.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalityRegistry, hasBirthMarker } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import { parseToolsetYaml } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  birthScaffoldedPersonalities,
  createBlankPersonality,
  duplicateBornPersonality,
  listUserPersonalityIds,
} from '../personality-create';

const FILING = 'propose_self_amendment';

let dataDir: string;
let storage: FsStorage;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'ethos-create-birth-')), '.ethos');
  storage = new FsStorage();
});

afterEach(() => {
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

async function toolsetOf(id: string): Promise<string[]> {
  return parseToolsetYaml(
    (await storage.read(join(dataDir, 'personalities', id, 'toolset.yaml'))) ?? '',
  );
}

/** What `scaffold_personality` writes (extensions/tools-personality-design). */
async function scaffold(id: string, toolset: string[]): Promise<void> {
  const dir = join(dataDir, 'personalities', id);
  await storage.mkdir(join(dir, 'files'));
  await storage.writeAtomic(join(dir, 'SOUL.md'), `# ${id}\n`);
  await storage.writeAtomic(join(dir, 'config.yaml'), `name: ${id}\n`);
  await storage.writeAtomic(
    join(dir, 'toolset.yaml'),
    `${toolset.map((t) => `- ${t}`).join('\n')}\n`,
  );
}

describe('ethos personality create — birth', () => {
  it('--blank creates a born personality through the registry create path', async () => {
    const id = await createBlankPersonality(storage, dataDir, 'Night Owl');
    expect(id).toBe('night-owl');
    expect(await hasBirthMarker(storage, dataDir, 'night-owl')).toBe(true);
    expect(await toolsetOf('night-owl')).toEqual(['read_file', 'write_file', 'terminal', FILING]);
    expect(await storage.read(join(dataDir, 'personalities', 'night-owl', 'config.yaml'))).toMatch(
      /^name: Night Owl\n/,
    );
  });

  it('--blank refuses an id that already exists and writes no marker', async () => {
    await scaffold('taken', ['read_file']);
    await expect(createBlankPersonality(storage, dataDir, 'taken')).rejects.toThrow(/exists/);
    expect(await hasBirthMarker(storage, dataDir, 'taken')).toBe(false);
  });

  it('--from duplicates the source and the copy is born; the source is left as it was', async () => {
    await scaffold('base', ['read_file']);
    await duplicateBornPersonality(storage, dataDir, 'base', 'copy');
    expect(await hasBirthMarker(storage, dataDir, 'copy')).toBe(true);
    expect(await toolsetOf('copy')).toEqual(['read_file', FILING]);
    expect(await hasBirthMarker(storage, dataDir, 'base')).toBe(false);
    expect(await toolsetOf('base')).toEqual(['read_file']);
  });

  it('--from a built-in works (a user copy of it is born)', async () => {
    const reg = await createPersonalityRegistry(storage);
    const builtin = reg.list().find((p) => (p.toolset?.length ?? 0) > 0);
    expect(builtin).toBeDefined();
    const sourceId = builtin?.id ?? '';
    await duplicateBornPersonality(storage, dataDir, sourceId, 'my-copy');
    expect(await hasBirthMarker(storage, dataDir, 'my-copy')).toBe(true);
    expect(await toolsetOf('my-copy')).toContain(FILING);
  });

  it('the AI-assisted path births exactly the personalities that appeared during the chat', async () => {
    await scaffold('existing', ['read_file']);
    const before = await listUserPersonalityIds(storage, dataDir);
    // The architect scaffolds one; the filing tool is NOT in what it granted.
    await scaffold('ledger', ['read_file']);
    const born = await birthScaffoldedPersonalities(storage, dataDir, before);
    expect(born).toEqual(['ledger']);
    expect(await hasBirthMarker(storage, dataDir, 'ledger')).toBe(true);
    expect(await toolsetOf('ledger')).toEqual(['read_file', FILING]);
    // What was there before the chat is untouched.
    expect(await hasBirthMarker(storage, dataDir, 'existing')).toBe(false);
    expect(await toolsetOf('existing')).toEqual(['read_file']);
  });

  it('the AI-assisted path skips a directory whose name is not a safe id, warns, and births the rest', async () => {
    const before = await listUserPersonalityIds(storage, dataDir);
    await scaffold('Bad Name', ['read_file']);
    await scaffold('ledger', ['read_file']);
    await scaffold('zeta', ['read_file']);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const born = await birthScaffoldedPersonalities(storage, dataDir, before);
      expect(born).toEqual(['ledger', 'zeta']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('Bad Name');
    } finally {
      warn.mockRestore();
    }
    expect(await hasBirthMarker(storage, dataDir, 'ledger')).toBe(true);
    expect(await hasBirthMarker(storage, dataDir, 'zeta')).toBe(true);
    expect(await toolsetOf('Bad Name')).toEqual(['read_file']);
  });

  it('the AI-assisted path births nothing when the chat created nothing', async () => {
    const before = await listUserPersonalityIds(storage, dataDir);
    expect(await birthScaffoldedPersonalities(storage, dataDir, before)).toEqual([]);
  });
});
