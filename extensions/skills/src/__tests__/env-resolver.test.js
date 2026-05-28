import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSkillEnv } from '../env-resolver';
import { filterSkill, setEnvResolverOptions } from '../ingest-filter';
function makeSkill(overrides = {}) {
    return {
        qualifiedName: 'ethos/coding-agent',
        name: 'Coding Agent',
        source: 'ethos',
        filePath: '/skills/coding-agent.md',
        body: '# body',
        rawFrontmatter: {},
        dialect: 'agentskills',
        mtimeMs: 1_000_000,
        ...overrides,
    };
}
function makePersonality(overrides = {}) {
    return {
        id: 'engineer',
        name: 'Engineer',
        toolset: ['read_file'],
        ...overrides,
    };
}
afterEach(() => setEnvResolverOptions(undefined));
describe('checkSkillEnv', () => {
    it('returns ok when no env dependencies are declared', () => {
        const r = checkSkillEnv(makeSkill());
        expect(r.ok).toBe(true);
        expect(r.missingEnv).toEqual([]);
        expect(r.missingCli).toEqual([]);
    });
    it('reports missing env_required vars', () => {
        const skill = makeSkill({
            env_required: [{ name: 'OPENAI_API_KEY' }, { name: 'ANTHROPIC_API_KEY' }],
        });
        const r = checkSkillEnv(skill, { env: { ANTHROPIC_API_KEY: 'sk-x' } });
        expect(r.ok).toBe(false);
        expect(r.missingEnv).toEqual(['OPENAI_API_KEY']);
    });
    it('treats empty-string env vars as unset', () => {
        const skill = makeSkill({ env_required: [{ name: 'TOKEN' }] });
        const r = checkSkillEnv(skill, { env: { TOKEN: '' } });
        expect(r.ok).toBe(false);
        expect(r.missingEnv).toEqual(['TOKEN']);
    });
    it('passes when at least one external_cli_alternative resolves', () => {
        const skill = makeSkill({
            external_cli_alternatives: ['claude', 'codex', 'opencode'],
        });
        const r = checkSkillEnv(skill, {
            which: (cmd) => cmd === 'codex',
        });
        expect(r.ok).toBe(true);
        expect(r.missingCli).toEqual([]);
    });
    it('reports missing CLI list when none resolve', () => {
        const skill = makeSkill({
            external_cli_alternatives: ['claude', 'codex'],
        });
        const r = checkSkillEnv(skill, { which: () => false });
        expect(r.ok).toBe(false);
        expect(r.missingCli).toEqual(['claude', 'codex']);
    });
    it('combines env + CLI checks', () => {
        const skill = makeSkill({
            env_required: [{ name: 'X' }],
            external_cli_alternatives: ['claude'],
        });
        const r = checkSkillEnv(skill, { env: {}, which: () => false });
        expect(r.ok).toBe(false);
        expect(r.missingEnv).toEqual(['X']);
        expect(r.missingCli).toEqual(['claude']);
    });
});
describe('filterSkill — env_required integration (E2)', () => {
    it('filters out skill when env_required is unset and warns', () => {
        setEnvResolverOptions({ env: {}, which: () => false });
        const warn = vi.fn();
        const skill = makeSkill({
            env_required: [{ name: 'OPENAI_API_KEY' }],
        });
        const result = filterSkill(skill, makePersonality(), new Set(['read_file']), warn);
        expect(result.include).toBe(false);
        expect(result.reason).toContain('OPENAI_API_KEY');
        expect(warn).toHaveBeenCalledOnce();
    });
    it('includes skill when env_required is set', () => {
        setEnvResolverOptions({ env: { OPENAI_API_KEY: 'sk-x' }, which: () => false });
        const skill = makeSkill({
            env_required: [{ name: 'OPENAI_API_KEY' }],
        });
        const result = filterSkill(skill, makePersonality(), new Set(['read_file']));
        expect(result.include).toBe(true);
    });
    it('filters out when no external_cli_alternative resolves', () => {
        setEnvResolverOptions({ env: {}, which: () => false });
        const skill = makeSkill({
            external_cli_alternatives: ['claude', 'codex', 'opencode', 'pi'],
        });
        const result = filterSkill(skill, makePersonality(), new Set(['read_file']));
        expect(result.include).toBe(false);
        expect(result.reason).toContain('no CLI on PATH');
        expect(result.reason).toContain('claude');
    });
    it('includes when any alternative resolves', () => {
        setEnvResolverOptions({ env: {}, which: (c) => c === 'codex' });
        const skill = makeSkill({
            external_cli_alternatives: ['claude', 'codex'],
        });
        const result = filterSkill(skill, makePersonality(), new Set(['read_file']));
        expect(result.include).toBe(true);
    });
    it('env-required check does not block skills that declare neither env nor cli', () => {
        setEnvResolverOptions({ env: {}, which: () => false });
        const skill = makeSkill();
        const result = filterSkill(skill, makePersonality(), new Set(['read_file']));
        expect(result.include).toBe(true);
    });
    it('also enforces env on explicit-allow skills', () => {
        setEnvResolverOptions({ env: {}, which: () => false });
        const skill = makeSkill({
            qualifiedName: 'ethos/coding-agent',
            external_cli_alternatives: ['claude'],
        });
        const personality = makePersonality({
            skills: { global_ingest: { mode: 'explicit', allow: ['ethos/coding-agent'] } },
        });
        const result = filterSkill(skill, personality, new Set(['read_file']));
        expect(result.include).toBe(false);
        expect(result.reason).toContain('claude');
    });
});
