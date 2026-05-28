import { describe, expect, it, vi } from 'vitest';
import { ensureTeamSupervisors, stopTeamSupervisors, } from '../supervisor-lifecycle';
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const ENTRY = '/repo/apps/ethos/src/index.ts';
function personalityBot(name) {
    return { binding: { type: 'personality', name } };
}
function teamBot(teamName) {
    return { binding: { type: 'team', name: teamName } };
}
function makeDeps(overrides = {}) {
    return {
        readRuntime: vi.fn().mockReturnValue(null),
        isPidAlive: vi.fn().mockReturnValue(false),
        removeRuntime: vi.fn(),
        spawn: vi.fn().mockReturnValue({ pid: 123, unref: vi.fn() }),
        kill: vi.fn(),
        waitMs: 0,
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// ensureTeamSupervisors
// ---------------------------------------------------------------------------
describe('ensureTeamSupervisors', () => {
    it('skips personality-bound bots and only handles team bots', async () => {
        const deps = makeDeps();
        const bots = [personalityBot('researcher'), teamBot('eng')];
        await ensureTeamSupervisors(bots, ENTRY, deps);
        expect(deps.spawn).toHaveBeenCalledOnce();
        const [, args] = vi.mocked(deps.spawn).mock.calls[0];
        expect(args).toContain('eng');
    });
    it('calls ensureSupervisorRunning for each unique team', async () => {
        const deps = makeDeps();
        const bots = [teamBot('eng'), teamBot('design')];
        await ensureTeamSupervisors(bots, ENTRY, deps);
        expect(deps.spawn).toHaveBeenCalledTimes(2);
    });
    it('deduplicates: two bots bound to the same team only spawn once', async () => {
        const deps = makeDeps();
        const bots = [teamBot('eng'), teamBot('eng')];
        await ensureTeamSupervisors(bots, ENTRY, deps);
        expect(deps.spawn).toHaveBeenCalledOnce();
    });
    it('does nothing when there are no team-bound bots', async () => {
        const deps = makeDeps();
        const bots = [personalityBot('researcher')];
        await ensureTeamSupervisors(bots, ENTRY, deps);
        expect(deps.spawn).not.toHaveBeenCalled();
    });
});
// ---------------------------------------------------------------------------
// stopTeamSupervisors
// ---------------------------------------------------------------------------
describe('stopTeamSupervisors', () => {
    it('stops supervisor for a team with autoStop: true when PID is alive', () => {
        const deps = makeDeps({
            readRuntime: () => ({
                name: 'eng',
                manifestPath: '',
                supervisorPid: 99,
                startedAt: '',
                members: [],
            }),
            isPidAlive: () => true,
        });
        const bots = [teamBot('eng')];
        const teamsCfg = { eng: { autoStop: true } };
        stopTeamSupervisors(bots, teamsCfg, deps);
        expect(deps.kill).toHaveBeenCalledWith(99, 'SIGTERM');
    });
    it('does not stop when autoStop is false', () => {
        const deps = makeDeps({ isPidAlive: () => true });
        const bots = [teamBot('eng')];
        const teamsCfg = { eng: { autoStop: false } };
        stopTeamSupervisors(bots, teamsCfg, deps);
        expect(deps.kill).not.toHaveBeenCalled();
    });
    it('does not stop when team has no autoStop config entry', () => {
        const deps = makeDeps({ isPidAlive: () => true });
        const bots = [teamBot('eng')];
        stopTeamSupervisors(bots, {}, deps);
        expect(deps.kill).not.toHaveBeenCalled();
    });
    it('skips personality-bound bots regardless of config', () => {
        const deps = makeDeps({ isPidAlive: () => true });
        const bots = [personalityBot('researcher')];
        const teamsCfg = { researcher: { autoStop: true } };
        stopTeamSupervisors(bots, teamsCfg, deps);
        expect(deps.kill).not.toHaveBeenCalled();
    });
});
