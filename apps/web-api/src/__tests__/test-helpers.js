import { DefaultHookRegistry } from '@ethosagent/core';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
export function makeStubAgentLoop(options = {}) {
    const events = options.events ?? [{ type: 'done', text: '', turnCount: 1 }];
    const stub = {
        // Real registry so createWebApi can register the web approval hook against
        // the stub without a special-case branch.
        hooks: new DefaultHookRegistry(),
        async *run(input, opts) {
            options.onRun?.(input, opts);
            for (const event of events)
                yield event;
        },
    };
    // Cast: `AgentLoop` has many private fields, but the runtime only needs `run`
    // for the AgentBridge to work. Tests that touch other methods will type-fail
    // here, prompting an explicit fix.
    return stub;
}
// ---------------------------------------------------------------------------
// PersonalityRegistry stub
//
// Tests that don't care about personalities pass `makeStubPersonalityRegistry()`.
// Tests that DO care provide an array of `PersonalityConfig` shapes to seed.
// ---------------------------------------------------------------------------
/**
 * Build a real FilePersonalityRegistry pre-populated with the given
 * personality configs. Optionally bind a `userPersonalitiesDir` so CRUD
 * methods (`create`/`update`/`deletePersonality`/`duplicate`) work.
 *
 * Tests that don't care about CRUD pass `personalities` only; tests that
 * exercise CRUD pass `userPersonalitiesDir` so the registry can write to
 * disk.
 */
export function makeStubPersonalityRegistry(personalities = [], userPersonalitiesDir) {
    const registry = new FilePersonalityRegistry(undefined, userPersonalitiesDir);
    for (const p of personalities)
        registry.define(p);
    if (personalities[0])
        registry.setDefault(personalities[0].id);
    return registry;
}
// ---------------------------------------------------------------------------
// MemoryProvider stub
//
// HTTP/route tests don't exercise the memory tab, but `createWebApi`
// requires the provider via options. Returns null/empty to exercise
// the backend-neutral path of the contract.
// ---------------------------------------------------------------------------
export function makeStubMemoryProvider() {
    return {
        async prefetch() {
            return null;
        },
        async read() {
            return null;
        },
        async search() {
            return [];
        },
        async sync() { },
        async list() {
            return [];
        },
    };
}
