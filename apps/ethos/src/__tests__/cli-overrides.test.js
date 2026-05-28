// FW-8 — CLI override flags: --model, --provider, --toolsets, -s
//
// These flags override ~/.ethos/config.yaml for a single invocation and must
// NOT persist. Validation errors throw EthosError with the documented codes.
//
// All four flags work for chat, -q, -c, -r, and --continue subcommands; the
// tests exercise the parsing and validation layer directly rather than spawning
// a full CLI process.
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { applyCliOverrides, parseCliOverrideFlags, VALID_PROVIDERS } from '../cli-overrides';
// ---------------------------------------------------------------------------
// Minimal config fixture — real fields, no side effects
// ---------------------------------------------------------------------------
const BASE_CONFIG = {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'sk-ant-test',
    personality: 'researcher',
};
// ---------------------------------------------------------------------------
// parseCliOverrideFlags — argv → raw flags struct
// ---------------------------------------------------------------------------
describe('parseCliOverrideFlags', () => {
    it('extracts --model from argv', () => {
        const flags = parseCliOverrideFlags(['chat', '--model', 'claude-foo']);
        expect(flags.model).toBe('claude-foo');
    });
    it('extracts --provider from argv', () => {
        const flags = parseCliOverrideFlags(['chat', '--provider', 'openrouter']);
        expect(flags.provider).toBe('openrouter');
    });
    it('extracts --toolsets from argv (comma-separated)', () => {
        const flags = parseCliOverrideFlags(['chat', '--toolsets', 'web,terminal']);
        expect(flags.toolsets).toEqual(['web', 'terminal']);
    });
    it('extracts -s from argv (comma-separated)', () => {
        const flags = parseCliOverrideFlags(['-s', 'skill1,skill2']);
        expect(flags.skills).toEqual(['skill1', 'skill2']);
    });
    it('returns undefined for absent flags', () => {
        const flags = parseCliOverrideFlags(['chat', 'hello']);
        expect(flags.model).toBeUndefined();
        expect(flags.provider).toBeUndefined();
        expect(flags.toolsets).toBeUndefined();
        expect(flags.skills).toBeUndefined();
    });
    it('all four flags compose in one invocation', () => {
        const flags = parseCliOverrideFlags([
            'chat',
            '--model',
            'claude-foo',
            '--provider',
            'anthropic',
            '--toolsets',
            'web,terminal',
            '-s',
            'my-skill',
        ]);
        expect(flags.model).toBe('claude-foo');
        expect(flags.provider).toBe('anthropic');
        expect(flags.toolsets).toEqual(['web', 'terminal']);
        expect(flags.skills).toEqual(['my-skill']);
    });
    it('does not consume an adjacent flag as a value', () => {
        // --model --provider anthropic must not set model='--provider'
        const flags = parseCliOverrideFlags(['--model', '--provider', 'anthropic']);
        expect(flags.model).toBeUndefined();
        expect(flags.provider).toBe('anthropic');
    });
});
// ---------------------------------------------------------------------------
// applyCliOverrides — config mutation and validation
// ---------------------------------------------------------------------------
describe('applyCliOverrides', () => {
    describe('--model', () => {
        it('overrides config.model', async () => {
            const storage = new InMemoryStorage();
            const result = await applyCliOverrides({ ...BASE_CONFIG }, { model: 'claude-foo' }, storage);
            expect(result.model).toBe('claude-foo');
        });
        it('does not mutate the original config object', async () => {
            const storage = new InMemoryStorage();
            const original = { ...BASE_CONFIG };
            await applyCliOverrides(original, { model: 'claude-foo' }, storage);
            expect(original.model).toBe('claude-opus-4-7');
        });
        it('applyCliOverrides is non-persistent: original config model survives a second call with no flags', async () => {
            const storage = new InMemoryStorage();
            // Apply an override for one invocation.
            const overridden = await applyCliOverrides({ ...BASE_CONFIG }, { model: 'claude-foo' }, storage);
            expect(overridden.model).toBe('claude-foo');
            // A fresh apply with no flags returns the base model — nothing was written back.
            const fresh = await applyCliOverrides({ ...BASE_CONFIG }, {}, storage);
            expect(fresh.model).toBe('claude-opus-4-7');
        });
    });
    describe('--provider', () => {
        it('overrides config.provider with a valid value', async () => {
            const storage = new InMemoryStorage();
            const result = await applyCliOverrides({ ...BASE_CONFIG }, { provider: 'openrouter' }, storage);
            expect(result.provider).toBe('openrouter');
        });
        it('accepts all VALID_PROVIDERS without error', async () => {
            const storage = new InMemoryStorage();
            for (const p of VALID_PROVIDERS) {
                const result = await applyCliOverrides({ ...BASE_CONFIG }, { provider: p }, storage);
                expect(result.provider).toBe(p);
            }
        });
        it('throws EthosError(INVALID_PROVIDER) for unknown provider', async () => {
            const storage = new InMemoryStorage();
            await expect(applyCliOverrides({ ...BASE_CONFIG }, { provider: 'not-real' }, storage)).rejects.toSatisfy((err) => {
                return err instanceof EthosError && err.code === 'INVALID_PROVIDER';
            });
        });
        it('error message lists valid provider options', async () => {
            const storage = new InMemoryStorage();
            try {
                await applyCliOverrides({ ...BASE_CONFIG }, { provider: 'not-real' }, storage);
                expect.fail('Expected an error');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EthosError);
                const e = err;
                expect(e.cause).toContain('not-real');
                // Must list the valid providers somewhere in cause or action.
                const combined = `${e.cause} ${e.action}`;
                for (const p of VALID_PROVIDERS) {
                    expect(combined).toContain(p);
                }
            }
        });
    });
    describe('--toolsets', () => {
        it('sets cliToolsets on the returned config', async () => {
            const storage = new InMemoryStorage();
            const result = await applyCliOverrides({ ...BASE_CONFIG }, { toolsets: ['web', 'terminal'] }, storage);
            expect(result.cliToolsets).toEqual(['web', 'terminal']);
        });
        it('throws EthosError(INVALID_TOOLSET) for unknown toolset', async () => {
            const storage = new InMemoryStorage();
            await expect(applyCliOverrides({ ...BASE_CONFIG }, { toolsets: ['unknown-set'] }, storage)).rejects.toSatisfy((err) => {
                return err instanceof EthosError && err.code === 'INVALID_TOOLSET';
            });
        });
        it('error message mentions the invalid toolset name', async () => {
            const storage = new InMemoryStorage();
            try {
                await applyCliOverrides({ ...BASE_CONFIG }, { toolsets: ['unknown-set'] }, storage);
                expect.fail('Expected an error');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EthosError);
                const e = err;
                expect(e.cause).toContain('unknown-set');
            }
        });
        it('a mix of valid and invalid toolsets fails on the first unknown', async () => {
            const storage = new InMemoryStorage();
            await expect(applyCliOverrides({ ...BASE_CONFIG }, { toolsets: ['web', 'bogus'] }, storage)).rejects.toSatisfy((err) => {
                return err instanceof EthosError && err.code === 'INVALID_TOOLSET';
            });
        });
    });
    describe('-s (skill preload)', () => {
        it('sets cliSkills on the returned config when skill file exists', async () => {
            const storage = new InMemoryStorage();
            // Populate ~/.ethos/skills/my-skill.md so the resolver finds it.
            await storage.mkdir('/home');
            await storage.mkdir('/home/user');
            await storage.mkdir('/home/user/.ethos');
            await storage.mkdir('/home/user/.ethos/skills');
            await storage.write('/home/user/.ethos/skills/my-skill.md', '# My Skill\n');
            const result = await applyCliOverrides({ ...BASE_CONFIG }, { skills: ['my-skill'], skillsDir: '/home/user/.ethos/skills' }, storage);
            expect(result.cliSkills).toEqual(['my-skill']);
        });
        it('throws EthosError(MISSING_SKILL) when skill file is not found', async () => {
            const storage = new InMemoryStorage();
            // No skill files exist in the storage.
            await expect(applyCliOverrides({ ...BASE_CONFIG }, { skills: ['ghost-skill'], skillsDir: '/home/user/.ethos/skills' }, storage)).rejects.toSatisfy((err) => {
                return err instanceof EthosError && err.code === 'MISSING_SKILL';
            });
        });
    });
    describe('all four flags compose', () => {
        it('model + provider + toolsets all apply together without conflict', async () => {
            const storage = new InMemoryStorage();
            const result = await applyCliOverrides({ ...BASE_CONFIG }, {
                model: 'claude-foo',
                provider: 'anthropic',
                toolsets: ['web', 'terminal'],
            }, storage);
            expect(result.model).toBe('claude-foo');
            expect(result.provider).toBe('anthropic');
            expect(result.cliToolsets).toEqual(['web', 'terminal']);
        });
    });
});
