import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPersonalityRegistry, FilePersonalityRegistry } from '../index';
let testDir;
beforeEach(async () => {
    testDir = join(tmpdir(), `ethos-personalities-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
});
afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
});
describe('FilePersonalityRegistry', () => {
    describe('built-ins via createPersonalityRegistry()', () => {
        it('loads built-in personalities', async () => {
            const registry = await createPersonalityRegistry();
            const ids = registry.list().map((p) => p.id);
            expect(ids).toContain('researcher');
            expect(ids).toContain('engineer');
            expect(ids).toContain('reviewer');
            expect(ids).toContain('personality-architect');
            expect(ids).toContain('team-architect');
            expect(ids).not.toContain('coach');
            expect(ids).not.toContain('operator');
            expect(ids).not.toContain('coordinator');
            expect(ids).not.toContain('task-tracker');
        });
        it('archived directory is not loaded as a personality', async () => {
            const registry = await createPersonalityRegistry();
            expect(registry.get('archived')).toBeUndefined();
        });
        it('researcher has soulFile and toolset', async () => {
            const registry = await createPersonalityRegistry();
            const researcher = registry.get('researcher');
            expect(researcher).toBeDefined();
            expect(researcher?.soulFile).toBeTruthy();
            expect(researcher?.toolset?.length).toBeGreaterThan(0);
            expect(researcher?.toolset).toContain('web_search');
        });
        it('reviewer toolset is read-only (no terminal or write tools)', async () => {
            const registry = await createPersonalityRegistry();
            const reviewer = registry.get('reviewer');
            expect(reviewer?.toolset).not.toContain('terminal');
            expect(reviewer?.toolset).not.toContain('write_file');
        });
        it('default personality is researcher', async () => {
            const registry = await createPersonalityRegistry();
            expect(registry.getDefault().id).toBe('researcher');
        });
    });
    describe('loadFromDirectory', () => {
        it('loads a user-defined personality from directory', async () => {
            const personalityDir = join(testDir, 'strategist');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Strategist\ndescription: Thinks in frameworks\nmodel: claude-opus-4-7\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Strategist\n\nI think in frameworks.');
            await writeFile(join(personalityDir, 'toolset.yaml'), '- web_search\n- read_file\n- memory_read\n');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const strategist = registry.get('strategist');
            expect(strategist).toBeDefined();
            expect(strategist?.name).toBe('Strategist');
            expect(strategist?.model).toBe('claude-opus-4-7');
            expect(strategist?.soulFile).toBeTruthy();
            expect(strategist?.toolset).toContain('web_search');
            expect(strategist?.toolset).toContain('memory_read');
        });
        it('skips directories without config.yaml or SOUL.md', async () => {
            await mkdir(join(testDir, 'empty-dir'));
            await writeFile(join(testDir, 'empty-dir', 'notes.txt'), 'nothing useful');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.list()).toHaveLength(0);
        });
        it('does not throw when directory does not exist', async () => {
            const registry = new FilePersonalityRegistry();
            await expect(registry.loadFromDirectory(join(testDir, 'nonexistent'))).resolves.not.toThrow();
        });
        it('uses mtime cache — second load skips unchanged personalities', async () => {
            const personalityDir = join(testDir, 'cached');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Cached\ndescription: Test\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Cached\n\nTest personality.');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('cached')?.name).toBe('Cached');
            // Mutate the in-memory config to detect if it gets overwritten
            registry.define({ id: 'cached', name: 'Mutated' });
            expect(registry.get('cached')?.name).toBe('Mutated');
            // Second load with same mtime → should NOT overwrite (cache hit)
            await registry.loadFromDirectory(testDir);
            expect(registry.get('cached')?.name).toBe('Mutated');
        });
        it('mtime cache invalidates when SOUL.md changes', async () => {
            const personalityDir = join(testDir, 'ethosedit');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Real\n');
            await writeFile(join(personalityDir, 'SOUL.md'), 'first version');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('ethosedit')?.name).toBe('Real');
            // Sentinel value to detect a reload (any reload overwrites it back to "Real")
            registry.define({ id: 'ethosedit', name: 'Sentinel' });
            // Touch SOUL.md with a future mtime so cache key changes regardless
            // of filesystem mtime resolution on this OS.
            const future = new Date(Date.now() + 10_000);
            const { utimes } = await import('node:fs/promises');
            await utimes(join(personalityDir, 'SOUL.md'), future, future);
            await registry.loadFromDirectory(testDir);
            expect(registry.get('ethosedit')?.name).toBe('Real');
        });
        it('mtime cache invalidates when toolset.yaml changes', async () => {
            const personalityDir = join(testDir, 'toolsetedit');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Tooled\n');
            await writeFile(join(personalityDir, 'SOUL.md'), 'identity');
            await writeFile(join(personalityDir, 'toolset.yaml'), '- read_file\n');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('toolsetedit')?.toolset).toEqual(['read_file']);
            // Replace toolset.yaml and bump its mtime to force cache invalidation
            await writeFile(join(personalityDir, 'toolset.yaml'), '- read_file\n- write_file\n');
            const future = new Date(Date.now() + 10_000);
            const { utimes } = await import('node:fs/promises');
            await utimes(join(personalityDir, 'toolset.yaml'), future, future);
            await registry.loadFromDirectory(testDir);
            expect(registry.get('toolsetedit')?.toolset).toEqual(['read_file', 'write_file']);
        });
    });
    describe('safety.observability config parsing', () => {
        it('parses safety.observability block from config.yaml', async () => {
            const dir = join(testDir, 'analyst');
            await mkdir(dir);
            await writeFile(join(dir, 'config.yaml'), [
                'name: Analyst',
                'model: claude-sonnet-4-6',
                'safety:',
                '  observability:',
                '    storeToolBodies: redacted',
                '    storeToolArgs: full',
            ].join('\n'));
            await writeFile(join(dir, 'SOUL.md'), '# Analyst');
            await writeFile(join(dir, 'toolset.yaml'), '- read_file\n');
            const registry = new FilePersonalityRegistry(undefined, testDir);
            await registry.loadFromDirectory(testDir);
            const p = registry.get('analyst');
            expect(p?.safety?.observability?.storeToolBodies).toBe('redacted');
            expect(p?.safety?.observability?.storeToolArgs).toBe('full');
        });
        it('personality without safety block loads with undefined safety', async () => {
            const dir = join(testDir, 'plain');
            await mkdir(dir);
            await writeFile(join(dir, 'config.yaml'), 'name: Plain\nmodel: claude-sonnet-4-6\n');
            await writeFile(join(dir, 'SOUL.md'), '# Plain');
            await writeFile(join(dir, 'toolset.yaml'), '- read_file\n');
            const registry = new FilePersonalityRegistry(undefined, testDir);
            await registry.loadFromDirectory(testDir);
            expect(registry.get('plain')?.safety).toBeUndefined();
        });
        it('rejects invalid storeToolBodies value', async () => {
            const dir = join(testDir, 'bad');
            await mkdir(dir);
            await writeFile(join(dir, 'config.yaml'), [
                'name: Bad',
                'model: claude-sonnet-4-6',
                'safety:',
                '  observability:',
                '    storeToolBodies: invalid-value',
            ].join('\n'));
            await writeFile(join(dir, 'SOUL.md'), '# Bad');
            await writeFile(join(dir, 'toolset.yaml'), '- read_file\n');
            const registry = new FilePersonalityRegistry(undefined, testDir);
            await expect(registry.loadFromDirectory(testDir)).rejects.toThrow(/storeToolBodies/);
        });
        it('rejects non-allowlisted nested top-level key', async () => {
            const dir = join(testDir, 'nested');
            await mkdir(dir);
            await writeFile(join(dir, 'config.yaml'), ['name: Nested', 'model: claude-sonnet-4-6', 'customBlock:', '  foo: bar'].join('\n'));
            await writeFile(join(dir, 'SOUL.md'), '# Nested');
            await writeFile(join(dir, 'toolset.yaml'), '- read_file\n');
            const registry = new FilePersonalityRegistry(undefined, testDir);
            await expect(registry.loadFromDirectory(testDir)).rejects.toThrow(/cannot be a nested object/);
        });
    });
    describe('define / get / list / setDefault', () => {
        it('define and get round-trip', () => {
            const registry = new FilePersonalityRegistry();
            registry.define({ id: 'custom', name: 'Custom', toolset: ['read_file'] });
            expect(registry.get('custom')?.toolset).toContain('read_file');
        });
        it('list returns all defined personalities', () => {
            const registry = new FilePersonalityRegistry();
            registry.define({ id: 'a', name: 'A' });
            registry.define({ id: 'b', name: 'B' });
            expect(registry.list().map((p) => p.id)).toEqual(expect.arrayContaining(['a', 'b']));
        });
        it('setDefault changes getDefault', () => {
            const registry = new FilePersonalityRegistry();
            registry.define({ id: 'x', name: 'X' });
            registry.setDefault('x');
            expect(registry.getDefault().id).toBe('x');
        });
        it('setDefault throws for unknown id', () => {
            const registry = new FilePersonalityRegistry();
            expect(() => registry.setDefault('unknown')).toThrow();
        });
    });
    // Ch.4b — load-time refusal of approvalMode: off + channel ingress
    describe('Ch.4b approvalMode + channel ingress validation', () => {
        it('parses approvalMode from config.yaml', async () => {
            const personalityDir = join(testDir, 'p1');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: P1\nsafety:\n  approvalMode: smart\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# P1');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('p1')?.safety?.approvalMode).toBe('smart');
        });
        it('rejects approvalMode: off + telegram', async () => {
            const personalityDir = join(testDir, 'bot');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Bot\nplatform: telegram\nsafety:\n  approvalMode: off\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Bot');
            const registry = new FilePersonalityRegistry();
            await expect(registry.loadFromDirectory(testDir)).rejects.toThrow(/approvalMode: off/);
        });
        it.each([
            'discord',
            'slack',
            'whatsapp',
            'email',
        ])('rejects approvalMode: off + %s', async (platform) => {
            const personalityDir = join(testDir, `p-${platform}`);
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), `name: P\nplatform: ${platform}\nsafety:\n  approvalMode: off\n`);
            await writeFile(join(personalityDir, 'SOUL.md'), '# P');
            const registry = new FilePersonalityRegistry();
            await expect(registry.loadFromDirectory(testDir)).rejects.toThrow(/approvalMode: off/);
        });
        it('allows approvalMode: off when platform is cli or absent', async () => {
            const personalityDir = join(testDir, 'cron');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Cron\nplatform: cli\nsafety:\n  approvalMode: off\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Cron');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('cron')?.safety?.approvalMode).toBe('off');
        });
        it('allows approvalMode: manual + telegram', async () => {
            const personalityDir = join(testDir, 'bot');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Bot\nplatform: telegram\nsafety:\n  approvalMode: manual\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Bot');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('bot')?.safety?.approvalMode).toBe('manual');
        });
        it('rejects invalid approvalMode value', async () => {
            const personalityDir = join(testDir, 'bad');
            await mkdir(personalityDir);
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Bad\nsafety:\n  approvalMode: paranoid\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Bad');
            const registry = new FilePersonalityRegistry();
            await expect(registry.loadFromDirectory(testDir)).rejects.toThrow(/Invalid approvalMode/);
        });
    });
    describe('model tier config', () => {
        it('parses dotted model keys into ModelTierConfig', async () => {
            const personalityDir = join(testDir, 'tiered');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Tiered\nmodel.trivial: haiku\nmodel.default: sonnet\nmodel.deep: opus\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Tiered');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const config = registry.get('tiered');
            expect(config).toBeDefined();
            expect(config?.model).toEqual({ trivial: 'haiku', default: 'sonnet', deep: 'opus' });
        });
        it('keeps plain model string for backward compatibility', async () => {
            const personalityDir = join(testDir, 'plain');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: Plain\nmodel: claude-sonnet-4-6\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# Plain');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const config = registry.get('plain');
            expect(config).toBeDefined();
            expect(config?.model).toBe('claude-sonnet-4-6');
        });
        it('engineer built-in has tier config with think_deeper in toolset', async () => {
            const registry = await createPersonalityRegistry();
            const engineer = registry.get('engineer');
            expect(engineer).toBeDefined();
            expect(typeof engineer?.model).toBe('object');
            const tiers = engineer?.model;
            expect(tiers.default).toBe('claude-sonnet-4-6');
            expect(tiers.deep).toBe('claude-opus-4-7');
            expect(engineer?.toolset).toContain('think_deeper');
        });
    });
    describe('dreaming config', () => {
        it('returns undefined when no dreaming keys are present', async () => {
            const personalityDir = join(testDir, 'no-dream');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: NoDream\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# NoDream');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('no-dream')?.dreaming).toBeUndefined();
        });
        it('returns undefined when dreaming.enable is false', async () => {
            const personalityDir = join(testDir, 'dream-off');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: DreamOff\ndreaming.enable: false\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# DreamOff');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('dream-off')?.dreaming).toBeUndefined();
        });
        it('returns defaults when only dreaming.enable is true', async () => {
            const personalityDir = join(testDir, 'dream-on');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: DreamOn\ndreaming.enable: true\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# DreamOn');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const dreaming = registry.get('dream-on')?.dreaming;
            expect(dreaming).toEqual({ enable: true, idleMinutes: 60, maxPerDay: 1 });
            expect(dreaming?.prompt).toBeUndefined();
        });
        it('parses all dreaming keys when set', async () => {
            const personalityDir = join(testDir, 'dream-full');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), `name: DreamFull
dreaming.enable: true
dreaming.idleMinutes: 30
dreaming.maxPerDay: 3
dreaming.prompt: Reflect.
`);
            await writeFile(join(personalityDir, 'SOUL.md'), '# DreamFull');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('dream-full')?.dreaming).toEqual({
                enable: true,
                idleMinutes: 30,
                maxPerDay: 3,
                prompt: 'Reflect.',
            });
        });
        it('falls back to default idleMinutes when value is non-numeric', async () => {
            const personalityDir = join(testDir, 'dream-bad');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: DreamBad\ndreaming.enable: true\ndreaming.idleMinutes: abc\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# DreamBad');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            expect(registry.get('dream-bad')?.dreaming?.idleMinutes).toBe(60);
        });
    });
    describe('model.dreaming tier', () => {
        it('parses model.dreaming into ModelTierConfig alongside model.default', async () => {
            const personalityDir = join(testDir, 'dream-model');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: DreamModel\nmodel.default: claude-sonnet-4-5\nmodel.dreaming: claude-haiku-4-5\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# DreamModel');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const config = registry.get('dream-model');
            expect(config?.model).toEqual({
                default: 'claude-sonnet-4-5',
                dreaming: 'claude-haiku-4-5',
            });
        });
        it('parses model.dreaming alone into ModelTierConfig', async () => {
            const personalityDir = join(testDir, 'dream-only');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: DreamOnly\nmodel.dreaming: claude-haiku-4-5\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# DreamOnly');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const config = registry.get('dream-only');
            expect(config?.model).toEqual({ dreaming: 'claude-haiku-4-5' });
        });
    });
    describe('memory config', () => {
        it('parses memory.provider from config.yaml', async () => {
            const personalityDir = join(testDir, 'mem-custom');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: MemCustom\nmemory.provider: vector\nmemory.options.embedding_model: text-3-large\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# MemCustom');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const config = registry.get('mem-custom');
            expect(config?.memory).toEqual({
                provider: 'vector',
                options: { embedding_model: 'text-3-large' },
            });
        });
        it('omits memory when no memory.provider is declared', async () => {
            const personalityDir = join(testDir, 'no-mem');
            await mkdir(personalityDir, { recursive: true });
            await writeFile(join(personalityDir, 'config.yaml'), 'name: NoMem\n');
            await writeFile(join(personalityDir, 'SOUL.md'), '# NoMem');
            const registry = new FilePersonalityRegistry();
            await registry.loadFromDirectory(testDir);
            const config = registry.get('no-mem');
            expect(config?.memory).toBeUndefined();
        });
    });
});
