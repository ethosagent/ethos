import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../in-memory-storage';
import { FileSecretsResolver, InMemorySecretsResolver } from '../secrets';

describe('FileSecretsResolver', () => {
  let storage: InMemoryStorage;
  let resolver: FileSecretsResolver;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir('/secrets');
    resolver = new FileSecretsResolver({ dir: '/secrets', storage });
  });

  it('get returns null for missing ref', async () => {
    expect(await resolver.get('providers/anthropic/apiKey')).toBeNull();
  });

  it('set + get round-trip', async () => {
    await resolver.set('providers/anthropic/apiKey', 'sk-ant-123');
    expect(await resolver.get('providers/anthropic/apiKey')).toBe('sk-ant-123');
  });

  it('set overwrites existing value (rotation)', async () => {
    await resolver.set('providers/anthropic/apiKey', 'old-key');
    await resolver.set('providers/anthropic/apiKey', 'new-key');
    expect(await resolver.get('providers/anthropic/apiKey')).toBe('new-key');
  });

  it('strips trailing newline on get', async () => {
    await storage.write('/secrets/simple', 'value\n');
    expect(await resolver.get('simple')).toBe('value');
  });

  it('delete removes the ref', async () => {
    await resolver.set('providers/openai/apiKey', 'sk-oai');
    await resolver.delete('providers/openai/apiKey');
    expect(await resolver.get('providers/openai/apiKey')).toBeNull();
  });

  it('delete is idempotent for missing ref', async () => {
    await expect(resolver.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('list returns refs under prefix', async () => {
    await resolver.set('providers/anthropic/apiKey', 'a');
    await resolver.set('providers/openai/apiKey', 'b');
    await resolver.set('slack/app-0/botToken', 'c');
    const providerRefs = await resolver.list('providers/');
    expect(providerRefs.sort()).toEqual(['providers/anthropic/apiKey', 'providers/openai/apiKey']);
  });

  it('list with no prefix returns all refs', async () => {
    await resolver.set('a', '1');
    await resolver.set('b/c', '2');
    const all = await resolver.list();
    expect(all.sort()).toEqual(['a', 'b/c']);
  });

  it('list returns empty for no matches', async () => {
    await resolver.set('providers/anthropic/apiKey', 'x');
    expect(await resolver.list('slack/')).toEqual([]);
  });

  it('creates nested directories on set', async () => {
    await resolver.set('slack/app-0/botToken', 'xoxb-123');
    expect(await resolver.get('slack/app-0/botToken')).toBe('xoxb-123');
  });

  describe('path validation', () => {
    it('rejects empty ref', async () => {
      await expect(resolver.get('')).rejects.toThrow('must not be empty');
    });

    it('rejects .. traversal', async () => {
      await expect(resolver.get('../etc/passwd')).rejects.toThrow('..');
    });

    it('rejects absolute path', async () => {
      await expect(resolver.get('/etc/passwd')).rejects.toThrow('absolute');
    });

    it('rejects NUL bytes', async () => {
      await expect(resolver.get('bad\0ref')).rejects.toThrow('NUL');
    });

    it('rejects empty segments', async () => {
      await expect(resolver.get('a//b')).rejects.toThrow('empty segments');
    });

    it('rejects Windows absolute path', async () => {
      await expect(resolver.get('C:\\secrets')).rejects.toThrow('backslash');
    });

    it('rejects backslash traversal', async () => {
      await expect(resolver.get('..\\outside')).rejects.toThrow('backslash');
    });
  });
});

describe('InMemorySecretsResolver', () => {
  let resolver: InMemorySecretsResolver;

  beforeEach(() => {
    resolver = new InMemorySecretsResolver();
  });

  it('get returns null for missing ref', async () => {
    expect(await resolver.get('missing')).toBeNull();
  });

  it('set + get round-trip', async () => {
    await resolver.set('key', 'value');
    expect(await resolver.get('key')).toBe('value');
  });

  it('delete removes the ref', async () => {
    await resolver.set('key', 'value');
    await resolver.delete('key');
    expect(await resolver.get('key')).toBeNull();
  });

  it('list with prefix', async () => {
    await resolver.set('a/1', 'x');
    await resolver.set('a/2', 'y');
    await resolver.set('b/1', 'z');
    expect((await resolver.list('a/')).sort()).toEqual(['a/1', 'a/2']);
  });

  it('list without prefix returns all', async () => {
    await resolver.set('x', '1');
    await resolver.set('y', '2');
    expect((await resolver.list()).sort()).toEqual(['x', 'y']);
  });

  it('behavior parity: set overwrites', async () => {
    await resolver.set('k', 'old');
    await resolver.set('k', 'new');
    expect(await resolver.get('k')).toBe('new');
  });

  it('behavior parity: delete is idempotent', async () => {
    await expect(resolver.delete('missing')).resolves.toBeUndefined();
  });
});
