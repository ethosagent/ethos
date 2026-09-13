// `ethos personality import` — the export-stamp warning (plan
// trust-before-reach P-T13).
//
// The stamp is an HMAC keyed with the PUBLIC constant `ETHOS_EXPORT_KEY`
// (apps/ethos/src/commands/personality-export.ts), so anyone can recompute it.
// It detects corruption in transit; it does not identify the publisher. The
// warning must say exactly that and must not imply an official or verified
// source.

import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPersonalityImport, writeTarGz } from '../backup';

// The trust prompt reads through readline; decline it so nothing is written.
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb('n'),
    close: () => {},
  }),
}));

const MISSING_WARNING =
  'no integrity stamp — the stamp detects corruption in transit; it does not identify the publisher';
const MISMATCH_WARNING =
  'integrity stamp does not match — the bundle was altered after export or corrupted in transit; the stamp does not identify the publisher';

let stateDir: string;
let prevStateDir: string | undefined;
let prevManaged: string | undefined;
let out: string[];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-import-stamp-'));
  prevStateDir = process.env.ETHOS_STATE_DIR;
  prevManaged = process.env.ETHOS_MANAGED;
  process.env.ETHOS_STATE_DIR = stateDir;
  delete process.env.ETHOS_MANAGED;
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
  if (prevManaged === undefined) delete process.env.ETHOS_MANAGED;
  else process.env.ETHOS_MANAGED = prevManaged;
  await rm(stateDir, { recursive: true, force: true });
});

async function writeBundle(stamp: string | undefined): Promise<string> {
  const files: never[] = [];
  const bundleSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const manifest = {
    schema: 'ethos.personality-bundle/v1',
    personalityId: 'neutral-import',
    version: '1.0.0',
    bundleSha256,
    declared: { fsReach: { read: [], write: [] }, toolset: [] },
    mcpServers: [],
    plugins: [],
    files,
    export: stamp === undefined ? {} : { stamp },
  };
  const archive = join(stateDir, 'bundle.tar.gz');
  await writeTarGz(
    [{ relPath: 'ETHOS.md', content: Buffer.from(JSON.stringify(manifest)) }],
    archive,
  );
  return archive;
}

function correctStamp(): string {
  const bundleSha256 = createHash('sha256').update(JSON.stringify([])).digest('hex');
  return createHmac('sha256', 'ethos-personality-export-v1').update(bundleSha256).digest('hex');
}

describe('ethos personality import — export stamp warning', () => {
  it('prints the missing-stamp warning when the bundle has no stamp', async () => {
    await runPersonalityImport([await writeBundle(undefined)]);

    const text = out.join('\n');
    expect(text).toContain(MISSING_WARNING);
    expect(text).not.toContain(MISMATCH_WARNING);
    expect(text.toLowerCase()).not.toContain('official');
    expect(text).toContain('Cancelled.');
  });

  it('prints the mismatch warning, not the missing-stamp one, when the stamp does not recompute', async () => {
    await runPersonalityImport([await writeBundle('0'.repeat(64))]);

    const text = out.join('\n');
    expect(text).toContain(MISMATCH_WARNING);
    expect(text).not.toContain(MISSING_WARNING);
    expect(text.toLowerCase()).not.toContain('official');
    expect(text).toContain('Cancelled.');
  });

  it('prints no stamp warning when the stamp recomputes', async () => {
    await runPersonalityImport([await writeBundle(correctStamp())]);

    const text = out.join('\n');
    expect(text).not.toContain(MISSING_WARNING);
    expect(text).not.toContain(MISMATCH_WARNING);
    expect(text).not.toContain('WARNING:');
    expect(text.toLowerCase()).not.toContain('official');
    expect(text).toContain('Cancelled.');
  });
});
