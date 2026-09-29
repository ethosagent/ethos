import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

// plan personality-presence-and-initiative §2 — `display.emoji`, the second
// sub-key of the `display` identity block. Parse (`buildDisplayConfig`),
// merge (`mergeDisplayConfig`, `''` clears), render (`renderConfigYaml`), and
// the load warning an invalid value produces instead of a crash.

const DATA = '/data';
const ROOT = join(DATA, 'personalities');

describe('display.emoji', () => {
  let storage: InMemoryStorage;
  let registry: FilePersonalityRegistry;

  beforeEach(() => {
    storage = new InMemoryStorage();
    registry = new FilePersonalityRegistry(storage, DATA);
  });

  async function seed(id: string, configYaml: string): Promise<void> {
    const dir = join(ROOT, id);
    await storage.mkdir(dir);
    await storage.write(join(dir, 'config.yaml'), configYaml);
    await storage.write(join(dir, 'SOUL.md'), `# ${id}\n\nIdentity.\n`);
  }

  it('loads a single emoji', async () => {
    await seed('owl', 'name: Owl\ndisplay.emoji: 🦉\n');
    await registry.loadFromDirectory(ROOT);
    expect(registry.get('owl')?.display).toEqual({ emoji: '🦉' });
    expect(registry.describe('owl')?.configWarnings).toBeUndefined();
    expect(registry.lastLoadReport.warnings).toBeUndefined();
  });

  it.each([
    ['a ZWJ family', '👨‍👩‍👧‍👦'],
    ['a flag', '🇯🇵'],
  ])('loads %s', async (_label, emoji) => {
    await seed('multi', `name: Multi\ndisplay.emoji: ${emoji}\n`);
    await registry.loadFromDirectory(ROOT);
    expect(registry.get('multi')?.display?.emoji).toBe(emoji);
  });

  it.each([
    ['two emoji', '🦉🦉'],
    ['letters', 'ab'],
    ['a 200-char string', 'x'.repeat(200)],
  ])('drops %s with a load warning instead of failing the load', async (_label, value) => {
    await seed(
      'bad',
      `name: Bad\ndisplay.avatar_url: /avatars/nova.svg\ndisplay.emoji: ${value}\n`,
    );
    await registry.loadFromDirectory(ROOT);
    const config = registry.get('bad');
    expect(config?.name).toBe('Bad');
    // The sibling sub-key survives; only the invalid emoji is dropped.
    expect(config?.display).toEqual({ avatar_url: '/avatars/nova.svg' });
    const warnings = registry.describe('bad')?.configWarnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/display\.emoji/);
    expect(registry.lastLoadReport.warnings).toEqual([{ id: 'bad', warning: warnings[0] }]);
    expect(registry.lastLoadReport.failures).toEqual([]);
  });

  it('writes an emoji through update() and reads it back, keeping avatar_url', async () => {
    await seed('nova', 'name: Nova\ndisplay.avatar_url: /avatars/nova.svg\n');
    await registry.loadFromDirectory(ROOT);

    await registry.update('nova', { display: { emoji: '🦉' } });
    expect(registry.get('nova')?.display).toEqual({
      avatar_url: '/avatars/nova.svg',
      emoji: '🦉',
    });
    const raw = await storage.read(join(ROOT, 'nova', 'config.yaml'));
    expect(raw).toContain('display.emoji: 🦉');
    expect(raw).toContain('display.avatar_url: /avatars/nova.svg');

    // A fresh registry over the same bytes sees the same block.
    const reloaded = new FilePersonalityRegistry(storage, DATA);
    await reloaded.loadFromDirectory(ROOT);
    expect(reloaded.get('nova')?.display).toEqual({
      avatar_url: '/avatars/nova.svg',
      emoji: '🦉',
    });
  });

  it('round-trips a keycap, which the YAML writer must quote (it starts with #)', async () => {
    await seed('key', 'name: Key\n');
    await registry.loadFromDirectory(ROOT);
    await registry.update('key', { display: { emoji: '#️⃣' } });
    const reloaded = new FilePersonalityRegistry(storage, DATA);
    await reloaded.loadFromDirectory(ROOT);
    expect(reloaded.get('key')?.display?.emoji).toBe('#️⃣');
  });

  it("'' clears the emoji and leaves avatar_url alone", async () => {
    await seed('nova', 'name: Nova\ndisplay.avatar_url: /avatars/nova.svg\ndisplay.emoji: 🦉\n');
    await registry.loadFromDirectory(ROOT);
    await registry.update('nova', { display: { emoji: '' } });
    expect(registry.get('nova')?.display).toEqual({ avatar_url: '/avatars/nova.svg' });
    const raw = await storage.read(join(ROOT, 'nova', 'config.yaml'));
    expect(raw).not.toContain('display.emoji');
  });

  it('clearing both sub-keys drops the display block, and an avatar patch keeps the emoji', async () => {
    await seed('nova', 'name: Nova\ndisplay.avatar_url: /avatars/nova.svg\ndisplay.emoji: 🦉\n');
    await registry.loadFromDirectory(ROOT);
    await registry.update('nova', { display: { avatar_url: '/avatars/milo.svg' } });
    expect(registry.get('nova')?.display).toEqual({
      avatar_url: '/avatars/milo.svg',
      emoji: '🦉',
    });
    await registry.update('nova', { display: { avatar_url: '', emoji: '' } });
    expect(registry.get('nova')?.display).toBeUndefined();
  });

  it('update() refuses a value that is not one emoji, and writes nothing', async () => {
    await seed('nova', 'name: Nova\n');
    await registry.loadFromDirectory(ROOT);
    await expect(registry.update('nova', { display: { emoji: '🦉🦉' } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await storage.read(join(ROOT, 'nova', 'config.yaml'))).toBe('name: Nova\n');
  });
});
