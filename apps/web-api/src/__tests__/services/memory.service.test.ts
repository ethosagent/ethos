import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService } from '../../services/memory.service';

const PERSONALITY_ID = 'test-agent';

describe('MemoryService', () => {
  let dir: string;
  let personalityDir: string;
  let service: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-memory-'));
    personalityDir = join(dir, 'personalities', PERSONALITY_ID);
    await mkdir(personalityDir, { recursive: true });
    service = new MemoryService({
      memory: new MarkdownFileMemoryProvider({ dir, storage: new FsStorage() }),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get returns empty content + null modifiedAt when the file does not exist', async () => {
    const { file } = await service.get('memory', PERSONALITY_ID);
    expect(file.store).toBe('memory');
    expect(file.content).toBe('');
    expect(file.modifiedAt).toBeNull();
    expect(file.path).toBeNull();
  });

  it('write creates the file and returns the freshly-read state', async () => {
    const result = await service.write('memory', '# project context\n\nfirst note', PERSONALITY_ID);
    // The markdown provider trims + appends a trailing newline on replace
    expect(result.file.content).toBe('# project context\n\nfirst note\n');
    expect(result.file.modifiedAt).not.toBeNull();
    expect(await readFile(join(personalityDir, 'MEMORY.md'), 'utf-8')).toBe(
      '# project context\n\nfirst note\n',
    );
  });

  it('write to user store uses USER.md in personality dir', async () => {
    await service.write('user', 'I am Mitesh.', PERSONALITY_ID);
    // The markdown provider trims + appends a trailing newline on replace.
    expect(await readFile(join(personalityDir, 'USER.md'), 'utf-8')).toBe('I am Mitesh.\n');
    const { file } = await service.get('user', PERSONALITY_ID);
    expect(file.path).toBeNull();
  });

  it('read picks up out-of-band edits', async () => {
    await writeFile(join(personalityDir, 'MEMORY.md'), 'edited externally');
    const { file } = await service.get('memory', PERSONALITY_ID);
    expect(file.content).toBe('edited externally');
  });

  it('list returns both files in [memory, user] order', async () => {
    await service.write('memory', 'm', PERSONALITY_ID);
    await service.write('user', 'u', PERSONALITY_ID);
    const { items } = await service.list(PERSONALITY_ID);
    expect(items.map((f) => f.store)).toEqual(['memory', 'user']);
  });

  it('listUsers returns empty when no identityMap is wired', async () => {
    const { users } = await service.listUsers();
    expect(users).toEqual([]);
  });
});
