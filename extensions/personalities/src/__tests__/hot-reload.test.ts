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

  it('criterion 7 — delete-then-refresh: a removed personality stops resolving (config + mcp policy); other-dir personalities survive', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);

    // A "built-in"-style personality loaded from a SEPARATE directory (a
    // different parent than the user dir — mirrors the package data dir). It
    // must survive a reconciliation scoped to the user dir.
    const BUILTIN_DIR = '/builtins';
    await storage.mkdir(join(BUILTIN_DIR, 'sage'));
    await storage.write(
      join(BUILTIN_DIR, 'sage', 'config.yaml'),
      'name: Sage\ndescription: test\n',
    );
    await storage.write(join(BUILTIN_DIR, 'sage', 'SOUL.md'), '# Sage\n');
    await registry.loadFromDirectory(BUILTIN_DIR);
    expect(registry.get('sage')).toBeDefined();

    // A user personality that also ships an mcp.yaml, so we can assert the
    // policy is dropped on deletion (the ghost-policy bug).
    await writePersonality(storage, 'ephemeral', { name: 'Ephemeral' });
    await storage.write(
      join(DIR, 'ephemeral', 'mcp.yaml'),
      'servers:\n  linear:\n    tools:\n      - list_issues\n',
    );
    await registry.loadFromDirectory(DIR);
    expect(registry.get('ephemeral')).toBeDefined();
    expect(registry.getMcpPolicy('ephemeral')).toBeDefined();

    // Delete the ONLY user personality directory, then refresh. The dir is now
    // empty — reconciliation must still run (no early return).
    await storage.remove(join(DIR, 'ephemeral'), { recursive: true });
    await registry.loadFromDirectory(DIR);

    // Removed everywhere: config AND the sibling mcp policy.
    expect(registry.get('ephemeral')).toBeUndefined();
    expect(registry.getMcpPolicy('ephemeral')).toBeUndefined();

    // The other-dir personality survived the user-dir refresh — built-ins are
    // never nuked by a user-dir reconciliation.
    expect(registry.get('sage')).toBeDefined();
  });

  it('installing the first skill into a personality with no skills/ dir invalidates the fingerprint', async () => {
    const storage = new InMemoryStorage();
    await writePersonality(storage, 'atlas', { name: 'Atlas' });

    const registry = new FilePersonalityRegistry(storage);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('atlas')?.skillsDirs).toBeUndefined();

    // Install a skill: the `skills/` DIRECTORY is created where none existed.
    // No fingerprinted FILE changed — only the directory. Without `skills/` in
    // the fingerprint, loadOne short-circuits and `skillsDirs` stays undefined
    // until the process restarts.
    const skillsDir = join(DIR, 'atlas', 'skills');
    await storage.mkdir(skillsDir);
    await storage.write(join(skillsDir, 'charts.md'), '---\nname: charts\n---\n# Charts\n');

    await registry.loadFromDirectory(DIR);

    expect(registry.get('atlas')?.skillsDirs).toEqual([skillsDir]);
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

  // plan decision-provider-personality §11 — config.yaml is one of the
  // fingerprinted paths, so an edited `decisions.*` line is seen on refresh.
  it('an edited decisions.sites line is seen by the next loadFromDirectory', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);
    await writePersonality(storage, 'judge', { name: 'Judge' });
    await registry.loadFromDirectory(DIR);
    expect(registry.get('judge')?.decisions).toBeUndefined();

    await storage.write(
      join(DIR, 'judge', 'config.yaml'),
      'name: Judge\ndecisions.provider: typesafe\ndecisions.sites.injection: shadow\n',
    );
    await registry.loadFromDirectory(DIR);
    expect(registry.get('judge')?.decisions).toEqual({
      provider: 'typesafe',
      sites: { injection: 'shadow' },
    });
  });
});

// N3 (ux-feedback-and-config-clarity) — resilient loading. One malformed
// directory no longer blocks its siblings: every successful loadOne is
// applied before the call settles, the failure lands on `lastLoadReport`
// with the dir and a file-attributed error, and the call still REJECTS so
// callers that fail closed today (CLI wiring, gateway first boot) keep doing
// so. A previously-loaded personality whose reload breaks serves its
// last-good copy.
describe('personality load resilience (N3)', () => {
  // `approvalMode: off` + a channel binding is refused at load
  // (validateUnsafeCombinations) — a reliable parse-time failure.
  async function writeBroken(storage: Storage, id: string): Promise<void> {
    const pdir = join(DIR, id);
    await storage.mkdir(pdir);
    await storage.write(
      join(pdir, 'config.yaml'),
      'name: Broken\nplatform: telegram\nsafety:\n  approvalMode: off\n',
    );
    await storage.write(join(pdir, 'SOUL.md'), '# Broken\n');
  }

  it('one bad directory does not block the others; the report names the dir and the error', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);
    await writePersonality(storage, 'sage', { name: 'Sage' });
    await writeBroken(storage, 'broken');

    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(/approvalMode: off/);

    // The sibling loaded despite the rejection.
    expect(registry.get('sage')?.name).toBe('Sage');
    expect(registry.get('broken')).toBeUndefined();

    const report = registry.lastLoadReport;
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.id).toBe('broken');
    expect(report.failures[0]?.dir).toBe(join(DIR, 'broken'));
    // File-level attribution: the error names its source file.
    expect(report.failures[0]?.error).toMatch(/^config\.yaml: /);
  });

  it('a previously-loaded personality whose reload now fails keeps serving the last-good copy', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);
    await writePersonality(storage, 'sage', { name: 'Sage v1' });
    await registry.loadFromDirectory(DIR);
    expect(registry.get('sage')?.name).toBe('Sage v1');

    // Breaking edit.
    await storage.write(
      join(DIR, 'sage', 'config.yaml'),
      'name: Sage v2\nplatform: telegram\nsafety:\n  approvalMode: off\n',
    );
    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(/approvalMode: off/);

    // Last-good copy still serves.
    expect(registry.get('sage')?.name).toBe('Sage v1');
    expect(registry.lastLoadReport.failures[0]?.id).toBe('sage');

    // The failure is reported once per content change, not once per refresh:
    // the unchanged broken dir is skipped by the fingerprint fast path.
    await registry.loadFromDirectory(DIR);
    expect(registry.lastLoadReport.failures).toHaveLength(0);

    // Fixing the file re-parses and serves the new copy.
    await storage.write(join(DIR, 'sage', 'config.yaml'), 'name: Sage v3\n');
    await registry.loadFromDirectory(DIR);
    expect(registry.get('sage')?.name).toBe('Sage v3');
  });

  it('the report notes reloads with the changed files named', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);
    await writePersonality(storage, 'sage', { name: 'Sage' });
    await registry.loadFromDirectory(DIR);
    // First sight is not a reload.
    expect(registry.lastLoadReport.reloaded).toHaveLength(0);

    await storage.write(join(DIR, 'sage', 'SOUL.md'), '# Sage\n\nedited\n');
    await registry.loadFromDirectory(DIR);
    expect(registry.lastLoadReport.reloaded).toEqual([{ id: 'sage', changed: ['SOUL.md'] }]);

    // A no-change refresh reports nothing.
    await registry.loadFromDirectory(DIR);
    expect(registry.lastLoadReport.reloaded).toHaveLength(0);
  });
});
