import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { FilePersonalityRegistry } from '../index';

const DIR = '/data/personalities';

async function writePersonality(
  storage: Storage,
  id: string,
  opts: { name: string; description?: string; soul?: string },
): Promise<void> {
  const pdir = join(DIR, id);
  await storage.mkdir(pdir);
  await storage.write(
    join(pdir, 'config.yaml'),
    `name: ${opts.name}\ndescription: ${opts.description ?? 'test'}\n`,
  );
  await storage.write(join(pdir, 'SOUL.md'), opts.soul ?? `# ${opts.name}\n`);
  await storage.write(join(pdir, 'toolset.yaml'), '- read_file\n');
}

describe('personality hot-reload — refresh-on-resolve', () => {
  it('criterion 1 — drop-a-directory hot-load: a new personality resolves after refresh, no restart', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);

    // Boot-load an empty personalities dir.
    await storage.mkdir(DIR);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('strategist')).toBeUndefined();

    // Drop a new personality directory on disk after boot.
    await writePersonality(storage, 'strategist', { name: 'Strategist' });

    // Refresh (the seam callers do this before resolving a turn).
    await registry.loadFromDirectory(DIR);

    const resolved = registry.get('strategist');
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('Strategist');
  });

  it('criterion 2 — edit-then-turn: an edited personality serves new content after refresh (fingerprint invalidated)', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);

    await writePersonality(storage, 'sage', { name: 'Sage v1', soul: '# Sage\n\nv1 body\n' });
    await registry.loadFromDirectory(DIR);
    expect(registry.get('sage')?.name).toBe('Sage v1');
    expect(await registry.readSoulMd('sage')).toContain('v1 body');

    // Edit config.yaml (name) AND SOUL.md on disk — a rewrite bumps mtime, so
    // the 4-file fingerprint changes and loadOne re-parses.
    await storage.write(join(DIR, 'sage', 'config.yaml'), 'name: Sage v2\ndescription: test\n');
    await storage.write(join(DIR, 'sage', 'SOUL.md'), '# Sage\n\nv2 body\n');

    await registry.loadFromDirectory(DIR);
    expect(registry.get('sage')?.name).toBe('Sage v2');
    expect(await registry.readSoulMd('sage')).toContain('v2 body');
  });

  it('criterion 3 — cross-process: create via instance A, refresh() on instance B, resolve via B', async () => {
    const storage = new InMemoryStorage();
    // Instance A owns the writable user dir (CRUD enabled); B is a bare reader
    // over the SAME storage — simulating two processes sharing one disk.
    const a = new FilePersonalityRegistry(storage, '/data');
    const b = new FilePersonalityRegistry(storage);

    await a.loadFromDirectory(DIR);
    await b.loadFromDirectory(DIR);
    expect(b.get('nova')).toBeUndefined();

    await a.create({
      id: 'nova',
      name: 'Nova',
      toolset: ['read_file'],
      soulMd: '# Nova\n',
    });

    // B has never heard of nova until it refreshes from disk.
    expect(b.get('nova')).toBeUndefined();
    await b.loadFromDirectory(DIR);

    const resolved = b.get('nova');
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('Nova');
  });

  it('criterion 6 — fingerprint fast path: a no-change refresh performs no read() and no re-parse', async () => {
    const storage = new InMemoryStorage();
    await writePersonality(storage, 'atlas', { name: 'Atlas' });

    const registry = new FilePersonalityRegistry(storage);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('atlas')).toBeDefined();

    // Spy AFTER the first load so we count only the second (no-change) pass.
    const readSpy = vi.spyOn(storage, 'read');
    const mtimeSpy = vi.spyOn(storage, 'mtime');

    await registry.loadFromDirectory(DIR);

    // Fast path returns before buildConfig — zero content reads on a no-change
    // refresh; only mtime/stat traffic for the fingerprint.
    expect(readSpy).not.toHaveBeenCalled();
    expect(mtimeSpy).toHaveBeenCalled();
  });
});
