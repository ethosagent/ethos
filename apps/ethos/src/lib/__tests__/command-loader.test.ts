import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type CommandMeta,
  refreshCommandIfStale,
  scanCommandsIntoRegistry,
} from '../command-loader';
import { buildBaseRegistry, SlashCommandRegistry } from '../slash-commands';

async function makeStorage(files: Record<string, string>): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) await storage.mkdir(dir);
    await storage.write(path, content);
  }
  return storage;
}

describe('scanCommandsIntoRegistry', () => {
  it('registers a command from a markdown file', async () => {
    const storage = await makeStorage({
      '/commands/greet.md': [
        '---',
        'description: Greet someone',
        'argument-hint: <name>',
        '---',
        '',
        'Hello $ARGUMENTS, welcome!',
      ].join('\n'),
    });

    const registry = new SlashCommandRegistry();
    const cache = new Map<string, CommandMeta>();

    await scanCommandsIntoRegistry(
      storage,
      [{ path: '/commands', scope: 'global' }],
      registry,
      cache,
    );

    expect(registry.get('greet')).toBeDefined();
    expect(registry.get('greet')?.description).toBe('Greet someone');
    expect(registry.get('greet')?.prefix).toBe('[command]');
    expect(cache.get('greet')?.definition.prompt).toContain('Hello $ARGUMENTS');
    expect(cache.get('greet')?.definition.scope).toBe('global');
    expect(cache.get('greet')?.definition.argumentHint).toBe('<name>');
  });

  it('skips non-md files', async () => {
    const storage = await makeStorage({
      '/commands/readme.txt': 'not a command',
      '/commands/valid.md': '---\ndescription: Valid\n---\nDo something',
    });

    const registry = new SlashCommandRegistry();
    const cache = new Map<string, CommandMeta>();

    await scanCommandsIntoRegistry(
      storage,
      [{ path: '/commands', scope: 'global' }],
      registry,
      cache,
    );

    expect(cache.size).toBe(1);
    expect(cache.has('valid')).toBe(true);
  });

  it('parses allowed-tools from frontmatter', async () => {
    const storage = await makeStorage({
      '/commands/analyze.md': [
        '---',
        'description: Analyze code',
        'allowed-tools: [read_file, bash]',
        '---',
        '',
        'Analyze $ARGUMENTS',
      ].join('\n'),
    });

    const registry = new SlashCommandRegistry();
    const cache = new Map<string, CommandMeta>();

    await scanCommandsIntoRegistry(
      storage,
      [{ path: '/commands', scope: 'project' }],
      registry,
      cache,
    );

    const def = cache.get('analyze')?.definition;
    expect(def?.allowedTools).toEqual(['read_file', 'bash']);
    expect(def?.scope).toBe('project');
  });

  it('scans multiple directories', async () => {
    const storage = await makeStorage({
      '/global/a.md': '---\ndescription: Global A\n---\nGlobal command',
      '/project/b.md': '---\ndescription: Project B\n---\nProject command',
    });

    const registry = new SlashCommandRegistry();
    const cache = new Map<string, CommandMeta>();

    await scanCommandsIntoRegistry(
      storage,
      [
        { path: '/global', scope: 'global' },
        { path: '/project', scope: 'project' },
      ],
      registry,
      cache,
    );

    expect(cache.size).toBe(2);
    expect(cache.get('a')?.definition.scope).toBe('global');
    expect(cache.get('b')?.definition.scope).toBe('project');
  });
});

describe('refreshCommandIfStale', () => {
  it('returns undefined for unknown slug', async () => {
    const storage = new InMemoryStorage();
    const cache = new Map<string, CommandMeta>();

    const result = await refreshCommandIfStale(storage, 'nope', cache);
    expect(result).toBeUndefined();
  });

  it('refreshes when mtime changes', async () => {
    const storage = await makeStorage({
      '/commands/test.md': '---\ndescription: Version 1\n---\nOld prompt',
    });

    const registry = new SlashCommandRegistry();
    const cache = new Map<string, CommandMeta>();

    await scanCommandsIntoRegistry(
      storage,
      [{ path: '/commands', scope: 'global' }],
      registry,
      cache,
    );

    expect(cache.get('test')?.definition.prompt).toBe('Old prompt');

    // Simulate file change — InMemoryStorage advances its internal clock on write
    await storage.write('/commands/test.md', '---\ndescription: Version 2\n---\nNew prompt');

    const refreshed = await refreshCommandIfStale(storage, 'test', cache);
    expect(refreshed?.definition.prompt).toBe('New prompt');
    expect(refreshed?.definition.description).toBe('Version 2');
  });
});

describe('collision policy', () => {
  it('rejects shadowing a built-in slash command', () => {
    const registry = buildBaseRegistry();
    registry.register({
      name: 'help',
      description: 'Evil help',
      usage: '/help',
      prefix: '[command]',
    });
    expect(registry.get('help')?.description).toBe('Show all slash commands');
  });

  it('allows non-built-in names', () => {
    const registry = buildBaseRegistry();
    registry.register({
      name: 'deploy',
      description: 'Deploy the app',
      usage: '/deploy',
      prefix: '[command]',
    });
    expect(registry.get('deploy')?.description).toBe('Deploy the app');
  });

  it('allows namespaced names that contain a built-in suffix', () => {
    const registry = buildBaseRegistry();
    registry.register({
      name: 'myplugin:help',
      description: 'Plugin help',
      usage: '/myplugin:help',
      prefix: '[plugin:myplugin]',
    });
    expect(registry.get('myplugin:help')?.description).toBe('Plugin help');
    expect(registry.get('help')?.description).toBe('Show all slash commands');
  });
});
