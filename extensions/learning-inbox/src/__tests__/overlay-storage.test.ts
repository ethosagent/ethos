// L-T3 — the replay isolation primitive: one shadowed path, every write
// refused. The loop-level proof (no write lands under `dataDir`, no tool
// executes, no outbox row, the shadow reaches the prompt) is
// `packages/wiring/src/__tests__/replay-isolation.test.ts`; this file pins the
// contract that test relies on.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { BoundaryError } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { OverlayStorage } from '../overlay-storage';

const SKILLS = '/ethos/skills';
const NEW_SKILL = `${SKILLS}/summarise.md`;
const LIVE_SKILL = `${SKILLS}/research.md`;
const SOUL = '/ethos/personalities/researcher/SOUL.md';

let base: InMemoryStorage;

beforeEach(async () => {
  base = new InMemoryStorage();
  await base.mkdir(SKILLS);
  await base.write(LIVE_SKILL, 'live research skill');
  await base.mkdir('/ethos/personalities/researcher');
  await base.write(SOUL, '# Core\nimmutable\n# Expression\nlive voice\n');
});

describe('reads', () => {
  it('serves the shadow at its own path and the base everywhere else', async () => {
    const overlay = new OverlayStorage(base, { path: NEW_SKILL, content: 'candidate bytes' });
    expect(await overlay.read(NEW_SKILL)).toBe('candidate bytes');
    expect(await overlay.read(LIVE_SKILL)).toBe('live research skill');
    expect(await overlay.read(`${SKILLS}/absent.md`)).toBeNull();
  });

  it('shadows a file that EXISTS, so a rewrite candidate is what is read', async () => {
    const overlay = new OverlayStorage(base, { path: LIVE_SKILL, content: 'rewritten' });
    expect(await overlay.read(LIVE_SKILL)).toBe('rewritten');
    // The base is untouched — the overlay is a view, not an edit.
    expect(await base.read(LIVE_SKILL)).toBe('live research skill');
  });

  it('matches the shadow path however it is spelled', async () => {
    const overlay = new OverlayStorage(base, { path: NEW_SKILL, content: 'candidate bytes' });
    expect(await overlay.read(`${SKILLS}/./summarise.md`)).toBe('candidate bytes');
    expect(await overlay.read(`${SKILLS}/nested/../summarise.md`)).toBe('candidate bytes');
  });

  it('reports the shadow as existing, with a stable mtime, and serves it as bytes', async () => {
    const overlay = new OverlayStorage(base, { path: NEW_SKILL, content: 'candidate bytes' });
    expect(await overlay.exists(NEW_SKILL)).toBe(true);
    expect(await base.exists(NEW_SKILL)).toBe(false);
    const first = await overlay.mtime(NEW_SKILL);
    expect(first).not.toBeNull();
    // Consumers cache parsed content by mtime (`UniversalScanner.loadSkill`);
    // a moving value would re-parse the same bytes on every read.
    expect(await overlay.mtime(NEW_SKILL)).toBe(first);
    expect(new TextDecoder().decode((await overlay.readBytes(NEW_SKILL)) ?? new Uint8Array())).toBe(
      'candidate bytes',
    );
  });
});

describe('listing — what makes a CREATE visible at all', () => {
  it('adds the shadow to its directory, with its own size and mtime', async () => {
    const overlay = new OverlayStorage(base, { path: NEW_SKILL, content: 'candidate bytes' });
    expect((await overlay.list(SKILLS)).sort()).toEqual(['research.md', 'summarise.md']);
    const entry = (await overlay.listEntries(SKILLS)).find((e) => e.name === 'summarise.md');
    expect(entry).toEqual({
      name: 'summarise.md',
      isDir: false,
      size: 'candidate bytes'.length,
      mtimeMs: await overlay.mtime(NEW_SKILL),
    });
  });

  it('replaces an existing entry rather than listing it twice', async () => {
    const overlay = new OverlayStorage(base, {
      path: LIVE_SKILL,
      content: 'a much longer rewrite',
    });
    const entries = await overlay.listEntries(SKILLS);
    expect(entries.filter((e) => e.name === 'research.md')).toHaveLength(1);
    expect(entries.find((e) => e.name === 'research.md')?.size).toBe(
      'a much longer rewrite'.length,
    );
    expect(await overlay.list(SKILLS)).toEqual(['research.md']);
  });

  it('leaves every other directory exactly as the base reports it', async () => {
    const overlay = new OverlayStorage(base, { path: NEW_SKILL, content: 'candidate bytes' });
    expect(await overlay.list('/ethos/personalities/researcher')).toEqual(['SOUL.md']);
  });
});

describe('writes — all of them refused', () => {
  const overlayOf = () => new OverlayStorage(base, { path: NEW_SKILL, content: 'candidate bytes' });

  it('throws BoundaryError from every mutating method, shadowed path or not', async () => {
    const overlay = overlayOf();
    const attempts: [string, Promise<unknown>][] = [
      ['write', overlay.write('/ethos/MEMORY.md', 'x')],
      ['write(shadow)', overlay.write(NEW_SKILL, 'x')],
      ['append', overlay.append('/ethos/learning/audit.jsonl', 'x\n')],
      ['writeAtomic', overlay.writeAtomic('/ethos/config.yaml', 'x')],
      ['mkdir', overlay.mkdir('/ethos/new-dir')],
      ['remove', overlay.remove(LIVE_SKILL)],
      ['rename', overlay.rename(LIVE_SKILL, `${SKILLS}/moved.md`)],
      ['chmod', overlay.chmod(LIVE_SKILL, 0o600)],
    ];
    for (const [label, attempt] of attempts) {
      await expect(attempt, label).rejects.toBeInstanceOf(BoundaryError);
    }
  });

  it('leaves the base untouched after a refusal', async () => {
    const overlay = overlayOf();
    await expect(overlay.remove(LIVE_SKILL)).rejects.toThrow();
    expect(await base.read(LIVE_SKILL)).toBe('live research skill');
    expect(await base.exists(NEW_SKILL)).toBe(false);
  });

  it('names the refusal so a surface can explain it', async () => {
    const overlay = overlayOf();
    await expect(overlay.write('/ethos/MEMORY.md', 'x')).rejects.toThrow(
      /replay overlay is read-only/,
    );
  });
});

describe('the baseline arm — an overlay with no shadow', () => {
  it('reads straight through and still refuses every write', async () => {
    const overlay = new OverlayStorage(base, null);
    expect(await overlay.read(LIVE_SKILL)).toBe('live research skill');
    expect(await overlay.read(NEW_SKILL)).toBeNull();
    expect(await overlay.exists(NEW_SKILL)).toBe(false);
    expect(await overlay.list(SKILLS)).toEqual(['research.md']);
    await expect(overlay.write(LIVE_SKILL, 'x')).rejects.toBeInstanceOf(BoundaryError);
  });
});
