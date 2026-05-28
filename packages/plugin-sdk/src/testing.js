import { AgentLoop, DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
// ---------------------------------------------------------------------------
// mockLLM — returns pre-defined text responses as streaming chunks
// ---------------------------------------------------------------------------
/**
 * Creates a mock `LLMProvider` that streams the given response strings in order.
 * Each string becomes a single `text_delta` chunk followed by a `done` chunk.
 */
export function mockLLM(responses) {
    let callCount = 0;
    return {
        name: 'mock',
        model: 'mock-model',
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete(_messages, _tools, _options) {
            const text = responses[callCount % responses.length] ?? '';
            callCount++;
            if (text)
                yield { type: 'text_delta', text };
            yield { type: 'done', finishReason: 'end_turn' };
        },
        async countTokens(_messages) {
            return 10;
        },
    };
}
// ---------------------------------------------------------------------------
// mockTool — returns a fixed result regardless of args
// ---------------------------------------------------------------------------
/**
 * Creates a `Tool` that always returns the given result.
 * Pass a string as shorthand for `{ ok: true, value: string }`.
 */
export function mockTool(name, result) {
    const toolResult = typeof result === 'string' ? { ok: true, value: result } : result;
    return {
        name,
        description: `Mock tool: ${name}`,
        schema: { type: 'object', properties: {} },
        capabilities: {},
        async execute(_args, _ctx) {
            return toolResult;
        },
    };
}
// ---------------------------------------------------------------------------
// createTestRuntime — minimal AgentLoop for plugin tests
// ---------------------------------------------------------------------------
/**
 * Creates a minimal `AgentLoop` suitable for plugin tests.
 * Provide at least `llm` — everything else defaults to no-op implementations.
 *
 * @example
 * const loop = createTestRuntime({ llm: mockLLM(['Hello!']) });
 * let final = '';
 * for await (const event of loop.run('hi')) {
 *   if (event.type === 'done') final = event.text;
 * }
 */
export function createTestRuntime(config) {
    return new AgentLoop({
        tools: new DefaultToolRegistry(),
        hooks: new DefaultHookRegistry(),
        ...config,
    });
}
