import { describe, expect, it } from 'vitest';
import { ChainedProvider } from '../providers/chained-provider';
function makeProvider(name, chunks) {
    return {
        name,
        model: `${name}-model`,
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete() {
            const result = typeof chunks === 'function' ? chunks() : undefined;
            if (result)
                throw result;
            for (const chunk of chunks) {
                yield chunk;
            }
        },
        async countTokens() {
            return 1;
        },
    };
}
function makeErrorProvider(name, errorMessage) {
    return makeProvider(name, () => new Error(errorMessage));
}
function makeSuccessProvider(name, text = 'ok') {
    return makeProvider(name, [
        { type: 'text_delta', text },
        {
            type: 'usage',
            usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                estimatedCostUsd: 0,
            },
        },
        { type: 'done', finishReason: 'end_turn' },
    ]);
}
async function collect(provider) {
    const chunks = [];
    for await (const chunk of provider.complete([], [], {})) {
        chunks.push(chunk);
    }
    return chunks;
}
describe('ChainedProvider', () => {
    it('uses the first provider on success', async () => {
        const chain = new ChainedProvider([makeSuccessProvider('a'), makeSuccessProvider('b')]);
        const chunks = await collect(chain);
        const text = chunks.find((c) => c.type === 'text_delta');
        expect(text?.text).toBe('ok');
        expect(chain.name).toContain('a');
    });
    it('fails over to the second provider on a rate_limit error', async () => {
        const chain = new ChainedProvider([
            makeErrorProvider('primary', '429 Too Many Requests'),
            makeSuccessProvider('fallback', 'fallback response'),
        ]);
        const chunks = await collect(chain);
        const text = chunks.find((c) => c.type === 'text_delta');
        expect(text?.text).toBe('fallback response');
    });
    it('fails over on overloaded error (529)', async () => {
        const chain = new ChainedProvider([
            makeErrorProvider('primary', '529 overloaded'),
            makeSuccessProvider('fallback'),
        ]);
        const chunks = await collect(chain);
        expect(chunks.find((c) => c.type === 'done')).toBeDefined();
    });
    it('fails over on network error', async () => {
        const chain = new ChainedProvider([
            makeErrorProvider('primary', 'ECONNREFUSED connection refused'),
            makeSuccessProvider('fallback'),
        ]);
        const chunks = await collect(chain);
        expect(chunks.find((c) => c.type === 'done')).toBeDefined();
    });
    it('does NOT fail over on auth error — propagates immediately', async () => {
        const chain = new ChainedProvider([
            makeErrorProvider('primary', '401 Unauthorized invalid api key'),
            makeSuccessProvider('fallback'),
        ]);
        await expect(collect(chain)).rejects.toThrow('401');
    });
    it('does NOT fail over on content_filter error', async () => {
        const chain = new ChainedProvider([
            makeErrorProvider('primary', 'content policy violation'),
            makeSuccessProvider('fallback'),
        ]);
        await expect(collect(chain)).rejects.toThrow('content policy');
    });
    it('throws ALL_PROVIDERS_FAILED when all providers fail with retriable errors', async () => {
        const chain = new ChainedProvider([
            makeErrorProvider('p1', '429 rate limit'),
            makeErrorProvider('p2', '529 overloaded'),
        ]);
        await expect(collect(chain)).rejects.toThrow('ALL_PROVIDERS_FAILED');
    });
    it('throws ALL_PROVIDERS_REJECT_MODEL when all providers fail with model_not_found', async () => {
        const chain = new ChainedProvider([
            makeErrorProvider('p1', '404 model not found'),
            makeErrorProvider('p2', '404 no such model'),
        ]);
        await expect(collect(chain)).rejects.toThrow('ALL_PROVIDERS_REJECT_MODEL');
    });
    it('exposes model from first available (non-cooled) provider', () => {
        const chain = new ChainedProvider([makeSuccessProvider('a'), makeSuccessProvider('b')]);
        expect(chain.model).toBe('a-model');
    });
    it('requires at least one provider', () => {
        expect(() => new ChainedProvider([])).toThrow('at least one provider');
    });
});
