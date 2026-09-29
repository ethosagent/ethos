// plan personality-presence-and-initiative §1 — `ethos personality birth skip
// <id>`: the owner's explicit decline of a birth ritual. It removes the birth
// marker, so `createBirthRitualInjector` (packages/wiring/src/birth-ritual.ts)
// stays silent from then on.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBirthMarker, writeBirthMarker } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPersonalityBirthCommand } from '../personality-birth';

let dataDir: string;
let storage: FsStorage;
let out: string[];

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'ethos-birth-cli-')), '.ethos');
  storage = new FsStorage();
  out = [];
});

afterEach(() => {
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

const deps = () => ({ storage, dataDir, out: (line: string) => out.push(line) });

describe('ethos personality birth skip', () => {
  it('removes the marker and says so', async () => {
    await writeBirthMarker(storage, dataDir, 'nova');
    await runPersonalityBirthCommand(['skip', 'nova'], deps());
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(false);
    expect(out.join('\n')).toContain('nova');
  });

  it('is a no-op with a note when there is no marker', async () => {
    await runPersonalityBirthCommand(['skip', 'nova'], deps());
    expect(out.join('\n')).toMatch(/no birth ritual/i);
  });

  it('refuses a missing or unsafe id and an unknown subcommand', async () => {
    for (const args of [['skip'], ['skip', '../x'], ['frob', 'nova']]) {
      await expect(runPersonalityBirthCommand(args, deps())).rejects.toBeInstanceOf(EthosError);
    }
  });
});
