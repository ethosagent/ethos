import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

const ctx: MemoryContext = {
  scopeId: 'personality:test',
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
};

let testDir: string;
/** Scoped directory where personality:test files live. */
let scopeDir: string;
let provider: MarkdownFileMemoryProvider;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-redact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  scopeDir = join(testDir, 'personalities', 'test');
  await mkdir(scopeDir, { recursive: true });
  provider = new MarkdownFileMemoryProvider({ dir: testDir, storage: new FsStorage() });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('credential redaction', () => {
  describe('sync — write path stores content as-is (no write-side redaction)', () => {
    it('stores an Anthropic key verbatim on add', async () => {
      const key = `sk-ant-${'A'.repeat(93)}`;
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: `Found key: ${key}` }], ctx);
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain(key);
      expect(content).not.toContain('[REDACTED');
    });

    it('stores an Anthropic key verbatim on replace', async () => {
      const key = `sk-ant-${'B'.repeat(93)}`;
      await writeFile(join(scopeDir, 'MEMORY.md'), 'Old content.\n');
      await provider.sync(
        [{ action: 'replace', key: 'MEMORY.md', content: `New content with ${key}` }],
        ctx,
      );
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain(key);
      expect(content).not.toContain('[REDACTED');
    });

    it('stores a GitHub PAT verbatim on add', async () => {
      const pat = `ghp_${'C'.repeat(36)}`;
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: `Token: ${pat}` }], ctx);
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain(pat);
      expect(content).not.toContain('[REDACTED');
    });

    it('stores an AWS access key verbatim on add', async () => {
      const awsKey = `AKIA${'D'.repeat(16)}`;
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: `AWS: ${awsKey}` }], ctx);
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain(awsKey);
      expect(content).not.toContain('[REDACTED');
    });

    it('stores generic key=value secrets verbatim on add', async () => {
      const secret = 'A'.repeat(20);
      await provider.sync(
        [{ action: 'add', key: 'MEMORY.md', content: `password=${secret}` }],
        ctx,
      );
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain(`password=${secret}`);
      expect(content).not.toContain('[REDACTED');
    });

    it('passes normal content through unchanged', async () => {
      const normal = 'The user prefers TypeScript and uses Biome for linting.';
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: normal }], ctx);
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain(normal);
      expect(content).not.toContain('[REDACTED');
    });
  });

  describe('read — returns raw content (no provider-side redaction)', () => {
    it('returns credentials as-is from read()', async () => {
      const key = `sk-ant-${'G'.repeat(93)}`;
      await writeFile(join(scopeDir, 'MEMORY.md'), `Old memory with key: ${key}`);

      const entry = await provider.read('MEMORY.md', ctx);
      expect(entry?.content).toContain(key);
      expect(entry?.content).not.toContain('[REDACTED');
    });

    it('returns a GitHub PAT as-is from read()', async () => {
      const pat = `ghp_${'H'.repeat(36)}`;
      await writeFile(join(scopeDir, 'USER.md'), `User token: ${pat}`);

      const entry = await provider.read('USER.md', ctx);
      expect(entry?.content).toContain(pat);
      expect(entry?.content).not.toContain('[REDACTED');
    });

    it('returns clean content unchanged from read()', async () => {
      const clean = 'The user prefers dark mode and Vim keybindings.';
      await writeFile(join(scopeDir, 'MEMORY.md'), clean);

      const entry = await provider.read('MEMORY.md', ctx);
      expect(entry?.content).toBe(clean);
    });
  });

  describe('search — returns raw content (no provider-side redaction)', () => {
    it('returns credentials as-is in search results', async () => {
      const key = `sk-ant-${'I'.repeat(93)}`;
      await writeFile(join(scopeDir, 'MEMORY.md'), `Project uses key: ${key}`);

      const results = await provider.search('project', ctx);
      expect(results.length).toBe(1);
      expect(results[0].content).toContain(key);
      expect(results[0].content).not.toContain('[REDACTED');
    });

    it('returns an AWS key as-is in search results', async () => {
      const awsKey = `AKIA${'J'.repeat(16)}`;
      await writeFile(join(scopeDir, 'USER.md'), `AWS credentials: ${awsKey}`);

      const results = await provider.search('aws', ctx);
      expect(results.length).toBe(1);
      expect(results[0].content).toContain(awsKey);
      expect(results[0].content).not.toContain('[REDACTED');
    });

    it('returns clean search results unchanged', async () => {
      const clean = 'The project uses TypeScript and Biome.';
      await writeFile(join(scopeDir, 'MEMORY.md'), clean);

      const results = await provider.search('typescript', ctx);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe(clean);
    });
  });

  describe('prefetch — returns raw content (no provider-side redaction)', () => {
    it('returns credentials as-is in MEMORY.md on prefetch', async () => {
      const key = `sk-ant-${'E'.repeat(93)}`;
      await writeFile(join(scopeDir, 'MEMORY.md'), `Old memory with key: ${key}`);

      const result = await provider.prefetch(ctx);
      const memEntry = result?.entries.find((e) => e.key === 'MEMORY.md');
      expect(memEntry?.content).toContain(key);
      expect(memEntry?.content).not.toContain('[REDACTED');
    });

    it('returns credentials as-is in USER.md on prefetch', async () => {
      const pat = `ghp_${'F'.repeat(36)}`;
      await writeFile(join(scopeDir, 'USER.md'), `User profile with token: ${pat}`);

      const result = await provider.prefetch(ctx);
      const userEntry = result?.entries.find((e) => e.key === 'USER.md');
      expect(userEntry?.content).toContain(pat);
      expect(userEntry?.content).not.toContain('[REDACTED');
    });

    it('returns clean content unchanged on prefetch', async () => {
      const clean = 'The user is a senior engineer who prefers TypeScript.';
      await writeFile(join(scopeDir, 'USER.md'), clean);

      const result = await provider.prefetch(ctx);
      const userEntry = result?.entries.find((e) => e.key === 'USER.md');
      expect(userEntry?.content).toBe(clean);
    });
  });
});
