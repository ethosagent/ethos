import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { DigestService } from '../../services/digest.service';

const DATA = '/data';

describe('DigestService', () => {
  it('returns null when the digests dir is missing', async () => {
    const storage = new InMemoryStorage();
    const service = new DigestService({ storage, dataDir: DATA });
    expect(await service.latest()).toBeNull();
  });

  it('returns null when the dir exists but holds no .md files', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(join(DATA, 'digests'));
    await storage.write(join(DATA, 'digests', 'notes.txt'), 'ignore me');
    const service = new DigestService({ storage, dataDir: DATA });
    expect(await service.latest()).toBeNull();
  });

  it('picks the lexicographically-greatest (newest ISO-week) file', async () => {
    const storage = new InMemoryStorage();
    const dir = join(DATA, 'digests');
    await storage.mkdir(dir);
    await storage.write(join(dir, '2026-W06.md'), '# old');
    await storage.write(join(dir, '2026-W07.md'), '# newest');
    await storage.write(join(dir, '2025-W52.md'), '# oldest');
    const service = new DigestService({ storage, dataDir: DATA });
    const latest = await service.latest();
    expect(latest?.label).toBe('2026-W07');
    expect(latest?.markdown).toBe('# newest');
    expect(typeof latest?.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(latest?.generatedAt ?? ''))).toBe(false);
  });
});
