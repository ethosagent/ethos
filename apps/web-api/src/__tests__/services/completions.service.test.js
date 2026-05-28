import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompletionsService } from '../../services/completions.service';
import { makeStubAgentLoop } from '../test-helpers';
const defaults = { model: 'claude-test', provider: 'anthropic' };
const fixedNow = () => new Date('2026-05-13T00:00:00.000Z');
const seqIds = () => {
    let n = 0;
    return () => `id-${++n}`;
};
function makeService(overrides = {}) {
    const sessions = new SQLiteSessionStore(':memory:');
    const loop = makeStubAgentLoop(overrides);
    const service = new CompletionsService({
        loop,
        sessions,
        defaults,
        now: fixedNow,
        newId: seqIds(),
    });
    return { service, sessions, loop };
}
const userOnly = (text) => ({
    model: 'engineer',
    messages: [{ role: 'user', content: text }],
});
describe('CompletionsService.complete', () => {
    let sessions;
    afterEach(() => sessions.close());
    beforeEach(() => { });
    it('returns OpenAI response shape for a single text turn', async () => {
        const ctx = makeService({
            events: [
                { type: 'text_delta', text: 'hello ' },
                { type: 'text_delta', text: 'world' },
                { type: 'usage', inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0 },
                { type: 'done', text: 'hello world', turnCount: 1 },
            ],
        });
        sessions = ctx.sessions;
        const out = await ctx.service.complete({ req: userOnly('hi'), personalityId: 'engineer' });
        expect(out.id).toBe('chatcmpl-id-1');
        expect(out.object).toBe('chat.completion');
        expect(out.created).toBe(Math.floor(fixedNow().getTime() / 1000));
        expect(out.model).toBe('engineer');
        expect(out.choices).toEqual([
            { index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' },
        ]);
        expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    });
    it('passes personalityId through to AgentLoop.run', async () => {
        let captured = null;
        const ctx = makeService({
            onRun: (input, opts) => {
                captured = { input, opts };
            },
            events: [{ type: 'done', text: '', turnCount: 1 }],
        });
        sessions = ctx.sessions;
        await ctx.service.complete({ req: userOnly('hello'), personalityId: 'researcher' });
        expect(captured).not.toBeNull();
        const o = captured;
        expect(o.input).toBe('hello');
        expect(o.opts.personalityId).toBe('researcher');
        expect(o.opts.sessionKey).toMatch(/^openai:ephem:/);
    });
    it('omits personalityId on the run opts when undefined (ethos-default path)', async () => {
        let opts = null;
        const ctx = makeService({
            onRun: (_input, o) => {
                opts = o;
            },
            events: [{ type: 'done', text: '', turnCount: 1 }],
        });
        sessions = ctx.sessions;
        await ctx.service.complete({ req: userOnly('hi'), personalityId: undefined });
        expect(opts).not.toBeNull();
        const o = opts;
        expect(o.personalityId).toBeUndefined();
    });
    it('throws on AgentLoop error event', async () => {
        const ctx = makeService({
            events: [
                { type: 'text_delta', text: 'partial' },
                { type: 'error', error: 'upstream went down', code: 'LLM_ERROR' },
            ],
        });
        sessions = ctx.sessions;
        await expect(ctx.service.complete({ req: userOnly('hi'), personalityId: 'engineer' })).rejects.toThrow(/upstream went down/);
    });
    it('throws when no user message ends the conversation', async () => {
        const ctx = makeService({});
        sessions = ctx.sessions;
        const req = {
            model: 'engineer',
            messages: [{ role: 'assistant', content: 'unprompted' }],
        };
        await expect(ctx.service.complete({ req, personalityId: 'engineer' })).rejects.toThrow(/messages must end with a `user` message/);
    });
    it('rejects [user, assistant] — refuses to silently rerun an earlier user prompt', async () => {
        const ctx = makeService({});
        sessions = ctx.sessions;
        const req = {
            model: 'engineer',
            messages: [
                { role: 'user', content: 'first prompt' },
                { role: 'assistant', content: 'answer' },
            ],
        };
        await expect(ctx.service.complete({ req, personalityId: 'engineer' })).rejects.toThrow(/messages must end with a `user` message/);
    });
    it('pre-populates the ephemeral session with prior user/assistant turns', async () => {
        const ctx = makeService({ events: [{ type: 'done', text: '', turnCount: 1 }] });
        sessions = ctx.sessions;
        const req = {
            model: 'engineer',
            messages: [
                { role: 'system', content: 'ignored' },
                { role: 'user', content: 'q1' },
                { role: 'assistant', content: 'a1' },
                { role: 'user', content: 'q2' },
            ],
        };
        await ctx.service.complete({ req, personalityId: 'engineer' });
        const list = await sessions.listSessions({});
        expect(list).toHaveLength(1);
        const session = list[0];
        if (!session)
            throw new Error('expected one session');
        expect(session.key).toMatch(/^openai:ephem:/);
        const messages = await sessions.getMessages(session.id);
        // System dropped, q1+a1 prepopulated (q2 is the live turn and not appended by the service).
        expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual(['user:q1', 'assistant:a1']);
    });
    it('does NOT pre-populate when X-Ethos-Session (stateful) is supplied', async () => {
        const ctx = makeService({ events: [{ type: 'done', text: '', turnCount: 1 }] });
        sessions = ctx.sessions;
        const req = {
            model: 'engineer',
            messages: [
                { role: 'user', content: 'q1' },
                { role: 'assistant', content: 'a1' },
                { role: 'user', content: 'q2' },
            ],
        };
        await ctx.service.complete({
            req,
            personalityId: 'engineer',
            sessionKeyOverride: 'my-session',
        });
        // No session row created by the service; AgentLoop would lazily create
        // `openai:my-session` on its own. The stub doesn't, so there are zero
        // sessions in the store.
        const list = await sessions.listSessions({});
        expect(list).toHaveLength(0);
    });
});
describe('CompletionsService.stream', () => {
    let sessions;
    afterEach(() => sessions.close());
    async function collect(gen) {
        const out = [];
        for await (const chunk of gen)
            out.push(chunk);
        return out;
    }
    it('yields a role-bearing first delta, then content-only deltas, then a final finish_reason chunk', async () => {
        const ctx = makeService({
            events: [
                { type: 'text_delta', text: 'foo' },
                { type: 'text_delta', text: 'bar' },
                { type: 'done', text: 'foobar', turnCount: 1 },
            ],
        });
        sessions = ctx.sessions;
        const chunks = await collect(ctx.service.stream({ req: userOnly('hi'), personalityId: 'engineer' }));
        expect(chunks).toHaveLength(3);
        expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: 'foo' });
        expect(chunks[1]?.choices[0]?.delta).toEqual({ content: 'bar' });
        expect(chunks[2]?.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
        expect(chunks[2]?.usage).toBeUndefined();
    });
    it('emits a usage chunk only when stream_options.include_usage is true', async () => {
        const ctx = makeService({
            events: [
                { type: 'text_delta', text: 'ok' },
                { type: 'usage', inputTokens: 4, outputTokens: 1, estimatedCostUsd: 0 },
                { type: 'done', text: 'ok', turnCount: 1 },
            ],
        });
        sessions = ctx.sessions;
        const req = {
            model: 'engineer',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            stream_options: { include_usage: true },
        };
        const chunks = await collect(ctx.service.stream({ req, personalityId: 'engineer' }));
        const usageChunk = chunks[chunks.length - 1];
        expect(usageChunk?.choices).toEqual([]);
        expect(usageChunk?.usage).toEqual({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
    });
    it('throws when AgentLoop emits an error event', async () => {
        const ctx = makeService({
            events: [{ type: 'error', error: 'boom', code: 'LLM_ERROR' }],
        });
        sessions = ctx.sessions;
        const gen = ctx.service.stream({ req: userOnly('hi'), personalityId: 'engineer' });
        await expect((async () => {
            for await (const _ of gen)
                void _;
        })()).rejects.toThrow(/boom/);
    });
    it('forwards abortSignal into AgentLoop.run', async () => {
        let opts = null;
        const ctx = makeService({
            onRun: (_input, o) => {
                opts = o;
            },
            events: [{ type: 'done', text: '', turnCount: 1 }],
        });
        sessions = ctx.sessions;
        const controller = new AbortController();
        await collect(ctx.service.stream({
            req: userOnly('hi'),
            personalityId: 'engineer',
            abortSignal: controller.signal,
        }));
        expect(opts).not.toBeNull();
        const o = opts;
        expect(o.abortSignal).toBe(controller.signal);
    });
});
