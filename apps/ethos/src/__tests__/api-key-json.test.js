import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let tempDir;
vi.mock('../config', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        ethosDir: () => tempDir,
    };
});
describe('ethos api-key --json', () => {
    let writeSpy;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'api-key-json-test-'));
        writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
        writeSpy.mockRestore();
    });
    describe('create --json', () => {
        it('outputs valid JSON with key, prefix, name, and scopes', async () => {
            const { runApiKey } = await import('../commands/api-key');
            await runApiKey(['create', '--name', 'clm-chat', '--scopes', 'chat', '--json']);
            const calls = writeSpy.mock.calls;
            expect(calls.length).toBeGreaterThanOrEqual(1);
            const output = String(calls[0]?.[0] ?? '');
            const parsed = JSON.parse(output);
            expect(parsed).toHaveProperty('key');
            expect(parsed).toHaveProperty('prefix');
            expect(parsed).toHaveProperty('name');
            expect(parsed).toHaveProperty('scopes');
            expect(parsed.name).toBe('clm-chat');
            expect(parsed.scopes).toEqual(['chat']);
            expect(typeof parsed.key).toBe('string');
            expect(typeof parsed.prefix).toBe('string');
        });
        it('does not include ANSI escape codes in JSON output', async () => {
            const { runApiKey } = await import('../commands/api-key');
            await runApiKey(['create', '--name', 'test-key', '--json']);
            const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
            // ESC character (0x1b) indicates ANSI escape sequences
            expect(output.includes(String.fromCharCode(0x1b))).toBe(false);
        });
    });
    describe('list --json', () => {
        it('outputs a JSON array with no key field (no secret material)', async () => {
            // Pre-populate a key via the store directly
            const store = new SqliteApiKeyStore(join(tempDir, 'sessions.db'));
            await store.create({ name: 'listed-key', scopes: ['chat', 'completions'] });
            store.close();
            const { runApiKey } = await import('../commands/api-key');
            await runApiKey(['list', '--json']);
            const calls = writeSpy.mock.calls;
            expect(calls.length).toBeGreaterThanOrEqual(1);
            const output = String(calls[0]?.[0] ?? '');
            const parsed = JSON.parse(output);
            expect(Array.isArray(parsed)).toBe(true);
            expect(parsed.length).toBeGreaterThanOrEqual(1);
            const entry = parsed[0];
            expect(entry).toHaveProperty('name');
            expect(entry).toHaveProperty('prefix');
            expect(entry).toHaveProperty('scopes');
            expect(entry).toHaveProperty('createdAt');
            expect(entry).not.toHaveProperty('key');
            expect(entry).not.toHaveProperty('secret');
        });
        it('reflects keys created in the same test', async () => {
            const store = new SqliteApiKeyStore(join(tempDir, 'sessions.db'));
            await store.create({ name: 'alpha', scopes: ['chat'] });
            await store.create({ name: 'beta', scopes: ['completions'] });
            store.close();
            const { runApiKey } = await import('../commands/api-key');
            await runApiKey(['list', '--json']);
            const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
            const parsed = JSON.parse(output);
            expect(Array.isArray(parsed)).toBe(true);
            const names = parsed.map((r) => r.name);
            expect(names).toContain('alpha');
            expect(names).toContain('beta');
        });
        it('returns an empty array when no keys exist', async () => {
            const { runApiKey } = await import('../commands/api-key');
            await runApiKey(['list', '--json']);
            const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
            const parsed = JSON.parse(output);
            expect(parsed).toEqual([]);
        });
    });
});
