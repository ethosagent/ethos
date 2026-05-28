import { InMemorySteerSink } from '@ethosagent/agent-bridge';
import { describe, expect, it } from 'vitest';
describe('FW-9 InMemorySteerSink', () => {
    it('push then drain returns the entries in order', () => {
        const sink = new InMemorySteerSink();
        sink.push('first');
        sink.push('second');
        expect(sink.depth()).toBe(2);
        expect(sink.drain()).toEqual(['first', 'second']);
        expect(sink.depth()).toBe(0);
    });
    it('drain is atomic — second drain returns []', () => {
        const sink = new InMemorySteerSink();
        sink.push('once');
        sink.drain();
        expect(sink.drain()).toEqual([]);
    });
    it('push returns false past cap', () => {
        const sink = new InMemorySteerSink({ cap: 2 });
        expect(sink.push('a')).toBe(true);
        expect(sink.push('b')).toBe(true);
        expect(sink.push('c')).toBe(false);
        expect(sink.depth()).toBe(2);
    });
});
// FW-9 mode dispatch behavior — the chat.ts handler is intentionally synchronous
// and mutates a single state object. We exercise that contract here by importing
// the dispatch helper directly. Note the chat REPL also covers this via manual
// smoke per the milestone, but a unit gate keeps the contract honest.
import { resolveBusyDispatch } from '../lib/busy-input';
describe('FW-9 busy mode dispatch logic', () => {
    it('interrupt: aborts current turn, queues new input as next turn', () => {
        const r = resolveBusyDispatch({ mode: 'interrupt', input: 'next', iterationsThisTurn: 1 });
        if (r.action !== 'interrupt')
            throw new Error('expected interrupt');
        expect(r.queueInput).toBe('next');
    });
    it('queue: appends to queue without aborting', () => {
        const r = resolveBusyDispatch({ mode: 'queue', input: 'next', iterationsThisTurn: 1 });
        if (r.action !== 'queue')
            throw new Error('expected queue');
        expect(r.queueInput).toBe('next');
    });
    it('steer: pushes to steer sink when iterationsThisTurn > 0', () => {
        const r = resolveBusyDispatch({ mode: 'steer', input: 'also do X', iterationsThisTurn: 1 });
        if (r.action !== 'steer')
            throw new Error('expected steer');
        expect(r.steerText).toBe('also do X');
    });
    it('steer pre-first-iteration falls back to queue', () => {
        const r = resolveBusyDispatch({ mode: 'steer', input: 'also do X', iterationsThisTurn: 0 });
        if (r.action !== 'queue')
            throw new Error('expected queue');
        expect(r.queueInput).toBe('also do X');
    });
    it('steer when no run is in flight falls back to queue (handled at REPL layer; helper returns steer)', () => {
        const r = resolveBusyDispatch({ mode: 'steer', input: 'x', iterationsThisTurn: 5 });
        expect(r.action).toBe('steer');
    });
});
