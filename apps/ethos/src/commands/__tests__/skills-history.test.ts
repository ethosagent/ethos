// Plan skill-history-and-lock, D3: `ethos skills history | diff | restore | lock | unlock`,
// run against InMemoryStorage through the command's storage seam (`SkillsHistoryDeps`),
// so none of it touches the real ~/.ethos or raw node:fs.

import { join } from 'node:path';
import { SkillHistory } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkillsHistoryCommand } from '../skills-history';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

const DATA = '/ethos';
const DEST = join(DATA, 'skills', 'tidy.md');

let storage: InMemoryStorage;
let out: string[];
let err: string[];
let h: JsonCliHarness;
const io = {
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
};
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (lines: string[]) => lines.join('\n').replace(ANSI, '');
const run = (args: string[]) => runSkillsHistoryCommand(args, { storage, dataDir: DATA, io });

beforeEach(async () => {
  h = await setupJsonCli('ethos-skills-history-');
  storage = new InMemoryStorage();
  out = [];
  err = [];
  await storage.mkdir(join(DATA, 'skills'));
});

afterEach(async () => {
  await h.teardown();
});

describe('ethos skills history', () => {
  it('a hand-written skill shows one external baseline row', async () => {
    await storage.write(DEST, 'by hand\n');
    expect(await run(['history', 'tidy'])).toBe(0);
    const text = plain(out);
    expect(text).toContain('external');
    expect(text.split('\n').filter((l) => /external/.test(l))).toHaveLength(1);
  });

  it('--json prints one document with the versions and the lock', async () => {
    await storage.write(DEST, 'by hand\n');
    expect(await run(['history', 'tidy', '--json'])).toBe(0);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, id: 'tidy', personalityId: null, locked: false });
    expect(doc.versions).toMatchObject([{ source: 'external', actor: 'external' }]);
  });

  it('--personality reads that personality’s skill, not the shared one', async () => {
    await storage.mkdir(join(DATA, 'personalities', 'coach', 'skills'));
    await storage.write(join(DATA, 'personalities', 'coach', 'skills', 'tidy.md'), 'mine\n');
    expect(await run(['history', 'tidy', '--personality', 'coach', '--json'])).toBe(0);
    expect(parseOneDoc(h)).toMatchObject({
      personalityId: 'coach',
      versions: [{ source: 'external' }],
    });
  });

  it('a skill that does not exist is NOT_FOUND', async () => {
    expect(await run(['history', 'ghost'])).toBe(1);
    expect(plain(err)).toContain('ghost');
  });

  it('an unsafe id is refused before touching storage', async () => {
    expect(await run(['history', '../etc'])).toBe(1);
    expect(plain(err)).toMatch(/invalid/i);
  });
});

describe('ethos skills diff', () => {
  async function twoVersions() {
    await storage.write(DEST, 'a\nb\n');
    const history = new SkillHistory({ storage, dataDir: DATA });
    await history.writeHuman(DEST, 'a\nc\n', { source: 'web-edit', actor: 'web' });
    return (await history.versions(DEST)).map((v) => v.versionId);
  }

  it('diffs a version against the live bytes by default', async () => {
    const [baseline] = await twoVersions();
    expect(await run(['diff', 'tidy', baseline ?? ''])).toBe(0);
    const text = plain(out);
    expect(text).toContain('-b');
    expect(text).toContain('+c');
    expect(text).toContain(' a');
  });

  it('diffs two versions, and --json carries the diff text', async () => {
    const [a, b] = await twoVersions();
    expect(await run(['diff', 'tidy', a ?? '', b ?? '', '--json'])).toBe(0);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, id: 'tidy', from: a, to: b });
    expect(String(doc.diff)).toContain('+c');
  });

  it('accepts a unique prefix of a version id', async () => {
    const [a] = await twoVersions();
    expect(await run(['diff', 'tidy', (a ?? '').slice(0, -1)])).toBe(0);
  });

  it('an unknown version is refused', async () => {
    await twoVersions();
    expect(await run(['diff', 'tidy', 'nope'])).toBe(1);
    expect(plain(err)).toContain('nope');
  });
});

describe('ethos skills restore', () => {
  it('writes the old bytes back as a new restore version', async () => {
    await storage.write(DEST, 'one\n');
    const history = new SkillHistory({ storage, dataDir: DATA });
    await history.writeHuman(DEST, 'two\n', { source: 'web-edit', actor: 'web' });
    const baseline = (await history.versions(DEST))[0];
    expect(await run(['restore', 'tidy', baseline?.versionId ?? ''])).toBe(0);
    expect(await storage.read(DEST)).toBe('one\n');
    const last = (await history.versions(DEST)).at(-1);
    expect(last).toMatchObject({
      source: 'restore',
      restoredFrom: baseline?.versionId,
      actor: 'cli',
    });
    expect(plain(out)).toContain(last?.versionId ?? 'missing');
  });

  it('--json prints the new version id', async () => {
    await storage.write(DEST, 'one\n');
    const history = new SkillHistory({ storage, dataDir: DATA });
    await history.writeHuman(DEST, 'two\n', { source: 'web-edit', actor: 'web' });
    const baseline = (await history.versions(DEST))[0];
    expect(await run(['restore', 'tidy', baseline?.versionId ?? '', '--json'])).toBe(0);
    expect(parseOneDoc(h)).toMatchObject({
      ok: true,
      id: 'tidy',
      restoredFrom: baseline?.versionId,
    });
  });

  it('an unknown version changes nothing', async () => {
    await storage.write(DEST, 'one\n');
    expect(await run(['restore', 'tidy', 'nope'])).toBe(1);
    expect(await storage.read(DEST)).toBe('one\n');
  });
});

describe('ethos skills lock and unlock', () => {
  it('lock then unlock flips the sidecar', async () => {
    await storage.write(DEST, 'one\n');
    const history = new SkillHistory({ storage, dataDir: DATA });
    expect(await run(['lock', 'tidy'])).toBe(0);
    expect(await history.isLocked(DEST)).toBe(true);
    expect(plain(out)).toContain('locked');
    expect(await run(['unlock', 'tidy'])).toBe(0);
    expect(await history.isLocked(DEST)).toBe(false);
  });

  it('works on a personality skill', async () => {
    const dest = join(DATA, 'personalities', 'coach', 'skills', 'tidy.md');
    await storage.mkdir(join(DATA, 'personalities', 'coach', 'skills'));
    await storage.write(dest, 'mine\n');
    expect(await run(['lock', 'tidy', '--personality', 'coach'])).toBe(0);
    expect(await new SkillHistory({ storage, dataDir: DATA }).isLocked(dest)).toBe(true);
    expect(await new SkillHistory({ storage, dataDir: DATA }).isLocked(DEST)).toBe(false);
  });

  it('refuses to lock a skill that does not exist', async () => {
    expect(await run(['lock', 'ghost'])).toBe(1);
    expect(plain(err)).toContain('ghost');
  });

  it('--json prints one document', async () => {
    await storage.write(DEST, 'one\n');
    expect(await run(['lock', 'tidy', '--json'])).toBe(0);
    expect(parseOneDoc(h)).toMatchObject({ ok: true, id: 'tidy', locked: true });
  });

  it('--json on a missing skill is one NOT_FOUND document', async () => {
    await expect(run(['lock', 'ghost', '--json'])).rejects.toThrow(EXIT);
    expect(parseOneDoc(h)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
