import { DefaultHookRegistry } from '@ethosagent/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerPostmortemHandler } from '../postmortem';
class StubMemoryProvider {
    entries = new Map();
    async prefetch(_ctx) {
        return null;
    }
    async read(key, _ctx) {
        const content = this.entries.get(key);
        if (content === undefined)
            return null;
        return { key, content };
    }
    async search(_query, _ctx) {
        return [];
    }
    async sync(updates, _ctx) {
        for (const u of updates) {
            if (u.action === 'replace') {
                this.entries.set(u.key, u.content);
            }
        }
    }
    async list(_ctx) {
        return [...this.entries.keys()].map((key) => ({ key }));
    }
}
describe('postmortem handler', () => {
    let hooks;
    let memory;
    beforeEach(() => {
        hooks = new DefaultHookRegistry();
        memory = new StubMemoryProvider();
    });
    const payload = {
        taskId: 'bda3f812',
        summary: 'Implemented OAuth refresh flow',
        acceptanceCriteria: 'no refresh tokens in logs',
        reason: 'logger middleware was logging full request body',
        assignee: 'engineer',
    };
    it('writes postmortem to team memory on revision', async () => {
        registerPostmortemHandler({ teamName: 'myteam', memory, hooks });
        await hooks.fireVoid('after_ticket_revision', payload);
        const key = 'postmortems/bda3f812.md';
        const content = memory.entries.get(key);
        expect(content).toBeDefined();
        expect(content).toContain('bda3f812 — needs revision');
        expect(content).toContain('**Assignee:** engineer');
        expect(content).toContain('logger middleware was logging full request body');
        expect(content).toContain('no refresh tokens in logs');
    });
    it('omits acceptance criteria when not set', async () => {
        registerPostmortemHandler({ teamName: 'myteam', memory, hooks });
        const { acceptanceCriteria: _, ...noAc } = payload;
        await hooks.fireVoid('after_ticket_revision', noAc);
        const key = 'postmortems/bda3f812.md';
        const content = memory.entries.get(key);
        expect(content).toBeDefined();
        expect(content).not.toContain('Acceptance criteria');
    });
    it('does not fire when handler is not registered', async () => {
        await hooks.fireVoid('after_ticket_revision', payload);
        expect(memory.entries.size).toBe(0);
    });
});
