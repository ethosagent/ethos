import { InMemoryStorage, ScopedStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { VaultMemoryProvider } from '../index';

const VAULT = '/vault';
const AGENT_ROOT = `${VAULT}/Ethos`;
const SCOPE_DIR = `${AGENT_ROOT}/personalities/sage`;

function ctx(): MemoryContext {
  return {
    scopeId: 'personality:sage',
    sessionId: 's1',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/work',
  };
}

async function seed(storage: InMemoryStorage): Promise<void> {
  await storage.mkdir(SCOPE_DIR);
  await storage.write(`${SCOPE_DIR}/MEMORY.md`, '# Project\n\nUses pnpm workspaces.\n');
  await storage.write(`${SCOPE_DIR}/USER.md`, '# User\n\nPrefers terse replies.\n');
}

describe('VaultMemoryProvider — five-method contract', () => {
  let storage: InMemoryStorage;
  let provider: VaultMemoryProvider;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    provider = new VaultMemoryProvider({ vaultRoot: VAULT, storage });
    await seed(storage);
  });

  it('prefetches the two rolling keys from the agent subtree', async () => {
    const snap = await provider.prefetch(ctx());
    expect(snap).not.toBeNull();
    expect(snap?.entries.map((e) => e.key)).toEqual(['MEMORY.md', 'USER.md']);
    expect(snap?.entries[0]?.content).toContain('pnpm workspaces');
  });

  it('returns null prefetch when the scope has no non-empty keys', async () => {
    const empty = new InMemoryStorage();
    const p = new VaultMemoryProvider({ vaultRoot: VAULT, storage: empty });
    expect(await p.prefetch(ctx())).toBeNull();
  });

  it('honours configurable prefetch keys', async () => {
    await storage.write(`${SCOPE_DIR}/notes.md`, 'custom prefetch\n');
    const p = new VaultMemoryProvider({ vaultRoot: VAULT, storage, prefetchKeys: ['notes.md'] });
    const snap = await p.prefetch(ctx());
    expect(snap?.entries.map((e) => e.key)).toEqual(['notes.md']);
  });

  it('applies add / replace / remove / delete via sync', async () => {
    await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Ships nightly.' }], ctx());
    let entry = await provider.read('MEMORY.md', ctx());
    expect(entry?.content).toContain('Ships nightly.');
    expect(entry?.content).toContain('pnpm workspaces');

    await provider.sync([{ action: 'replace', key: 'MEMORY.md', content: 'fresh slate' }], ctx());
    entry = await provider.read('MEMORY.md', ctx());
    expect(entry?.content).toBe('fresh slate\n');

    await provider.sync([{ action: 'remove', key: 'USER.md', substringMatch: 'terse' }], ctx());
    entry = await provider.read('USER.md', ctx());
    expect(entry?.content).not.toContain('terse');

    await provider.sync([{ action: 'delete', key: 'USER.md' }], ctx());
    expect(await provider.read('USER.md', ctx())).toBeNull();
  });

  it('lists the scope keys and excludes Obsidian conflict files', async () => {
    await storage.write(`${SCOPE_DIR}/MEMORY (conflict).md`, 'stale conflict copy\n');
    await storage.write(`${SCOPE_DIR}/MEMORY.sync-conflict-20260101.md`, 'sync conflict\n');
    const keys = (await provider.list(ctx())).map((r) => r.key).sort();
    expect(keys).toEqual(['MEMORY.md', 'USER.md']);
  });

  it('keyword-searches across the whole vault and skips conflict + dot files', async () => {
    await storage.mkdir(`${VAULT}/Notes`);
    await storage.write(`${VAULT}/Notes/coffee.md`, 'best espresso beans are Ethiopian\n');
    await storage.mkdir(`${VAULT}/.obsidian`);
    await storage.write(`${VAULT}/.obsidian/workspace.md`, 'espresso hidden config\n');
    await storage.write(`${VAULT}/Notes/coffee (conflict).md`, 'espresso conflict copy\n');

    const hits = await provider.search('espresso', ctx());
    const keys = hits.map((h) => h.key);
    expect(keys).toContain('Notes/coffee.md');
    expect(keys).not.toContain('.obsidian/workspace.md');
    expect(keys.some((k) => k.includes('conflict'))).toBe(false);
  });

  it('search returns [] for semantic mode (vector backend owns semantics)', async () => {
    expect(await provider.search('pnpm', ctx(), { mode: 'semantic' })).toEqual([]);
  });

  it('reads and writes the global entries at the agent-subtree root', async () => {
    const written = await provider.writeGlobalEntry('memory', 'global note\n');
    expect(written.path).toBe(`${AGENT_ROOT}/MEMORY.md`);
    const read = await provider.readGlobalEntry('memory');
    expect(read.content).toBe('global note\n');
  });
});

describe('VaultMemoryProvider — ScopedStorage confinement', () => {
  it('reads vault notes for search but refuses writes outside the agent subtree', async () => {
    const inner = new InMemoryStorage();
    await inner.mkdir(`${VAULT}/Private`);
    await inner.write(`${VAULT}/Private/secret.md`, 'roadmap keyword lives here\n');
    const scoped = new ScopedStorage(inner, {
      read: [`${VAULT}/`],
      write: [`${AGENT_ROOT}/`],
    });
    const provider = new VaultMemoryProvider({ vaultRoot: VAULT, storage: scoped });

    // Search may read across the whole vault.
    const hits = await provider.search('roadmap', ctx());
    expect(hits.map((h) => h.key)).toContain('Private/secret.md');

    // Writes inside the agent subtree succeed.
    await provider.sync([{ action: 'replace', key: 'MEMORY.md', content: 'ok' }], ctx());
    expect((await provider.read('MEMORY.md', ctx()))?.content).toBe('ok\n');

    // A scope that would route a write outside the agent subtree is blocked by
    // the ScopedStorage write allowlist. (Constructed here directly to prove
    // the boundary — the agent subtree is the only writable region.)
    await expect(scoped.write(`${VAULT}/Private/secret.md`, 'tampered')).rejects.toThrow();
  });
});

// A storage that fires a one-shot hook the first time the target file is read —
// simulating a concurrent Obsidian/iCloud write landing between the provider's
// pre-sync read and its write.
class ConcurrentEditStorage extends InMemoryStorage {
  fired = false;
  target = '';
  hook: () => Promise<void> = async () => {};

  override async read(path: string): Promise<string | null> {
    const value = await super.read(path);
    if (!this.fired && path === this.target) {
      this.fired = true;
      await this.hook();
    }
    return value;
  }
}

describe('VaultMemoryProvider — stale-write guard', () => {
  const FILE = `${SCOPE_DIR}/MEMORY.md`;

  it('does NOT clobber a file a concurrent editor touched mid-sync (replace)', async () => {
    const storage = new ConcurrentEditStorage();
    await storage.mkdir(SCOPE_DIR);
    await storage.write(FILE, 'agent basis\n');
    storage.target = FILE;
    // Obsidian saves a new version between the provider's read and its write.
    storage.hook = async () => {
      await storage.write(FILE, 'HUMAN EDIT in Obsidian\n');
    };

    const provider = new VaultMemoryProvider({ vaultRoot: VAULT, storage });
    await provider.sync(
      [{ action: 'replace', key: 'MEMORY.md', content: 'agent overwrite' }],
      ctx(),
    );

    // The destructive replace was skipped — the human's concurrent edit stands.
    expect(await storage.read(FILE)).toBe('HUMAN EDIT in Obsidian\n');
  });

  it('appends additive updates onto the concurrent content instead of clobbering', async () => {
    const storage = new ConcurrentEditStorage();
    await storage.mkdir(SCOPE_DIR);
    await storage.write(FILE, 'agent basis\n');
    storage.target = FILE;
    storage.hook = async () => {
      await storage.write(FILE, 'HUMAN EDIT in Obsidian\n');
    };

    const provider = new VaultMemoryProvider({ vaultRoot: VAULT, storage });
    await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'agent addendum' }], ctx());

    const final = await storage.read(FILE);
    // Concurrent content preserved AND the additive update appended onto it.
    expect(final).toContain('HUMAN EDIT in Obsidian');
    expect(final).toContain('agent addendum');
  });
});
