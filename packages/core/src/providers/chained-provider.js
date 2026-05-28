// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
function classifyProviderError(err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('authentication') ||
        msg.includes('api key') ||
        msg.includes('unauthorized'))
        return 'auth';
    if (msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('rate_limit') ||
        msg.includes('too many requests'))
        return 'rate_limit';
    if (msg.includes('529') ||
        msg.includes('overloaded') ||
        msg.includes('503') ||
        msg.includes('service unavailable'))
        return 'overloaded';
    if (msg.includes('context') &&
        (msg.includes('overflow') || msg.includes('too long') || msg.includes('too large')))
        return 'context_overflow';
    if (msg.includes('content') && (msg.includes('filter') || msg.includes('policy')))
        return 'content_filter';
    if (msg.includes('404') ||
        msg.includes('model not found') ||
        msg.includes('model_not_found') ||
        msg.includes('no such model'))
        return 'model_not_found';
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout'))
        return 'timeout';
    if (msg.includes('network') ||
        msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('socket hang up'))
        return 'network';
    return 'unknown';
}
// Reasons that warrant trying the next provider in the chain.
const FAILOVER_REASONS = new Set([
    'rate_limit',
    'overloaded',
    'timeout',
    'network',
    'unknown',
    'model_not_found',
]);
function shouldFailover(reason) {
    return FAILOVER_REASONS.has(reason);
}
/**
 * Wraps multiple LLMProviders with automatic failover.
 *
 * On a failover-eligible error (rate_limit, overloaded, timeout, network, unknown),
 * the failing provider is put on cooldown and the next provider is tried.
 * Non-retriable errors (auth, content_filter, context_overflow) propagate immediately.
 *
 * Once streaming starts (first CompletionChunk received), the stream is committed —
 * no mid-stream retries. Failover only happens on errors thrown before the first chunk.
 *
 * Error codes:
 *   ALL_PROVIDERS_FAILED         — every provider failed with a failover-eligible error
 *   ALL_PROVIDERS_REJECT_MODEL   — every provider failed with model_not_found
 */
export class ChainedProvider {
    entries;
    cooldownMs;
    constructor(providers, opts = {}) {
        if (providers.length === 0)
            throw new Error('ChainedProvider requires at least one provider');
        this.entries = providers.map((p) => ({ provider: p, cooldownUntil: 0 }));
        this.cooldownMs = opts.cooldownMs ?? 60_000;
    }
    get name() {
        return `chain(${this.entries.map((e) => e.provider.name).join(',')})`;
    }
    get model() {
        return this.activeEntry()?.provider.model ?? this.entries[0]?.provider.model ?? '';
    }
    get maxContextTokens() {
        return this.activeEntry()?.provider.maxContextTokens ?? 200_000;
    }
    get supportsCaching() {
        return this.activeEntry()?.provider.supportsCaching ?? false;
    }
    get supportsThinking() {
        return this.activeEntry()?.provider.supportsThinking ?? false;
    }
    async *complete(messages, tools, options) {
        const now = Date.now();
        const available = this.entries.filter((e) => e.cooldownUntil <= now);
        if (available.length === 0) {
            // All on cooldown — wait for the soonest one to recover then use it.
            const soonest = this.entries.reduce((a, b) => (a.cooldownUntil < b.cooldownUntil ? a : b));
            available.push(soonest);
        }
        const reasons = [];
        for (const entry of available) {
            try {
                const stream = entry.provider.complete(messages, tools, options);
                for await (const chunk of stream) {
                    yield chunk;
                }
                return;
            }
            catch (err) {
                const reason = classifyProviderError(err);
                reasons.push(reason);
                if (!shouldFailover(reason)) {
                    throw err;
                }
                entry.cooldownUntil = Date.now() + this.cooldownMs;
            }
        }
        // All available providers failed.
        const allModelNotFound = reasons.length > 0 && reasons.every((r) => r === 'model_not_found');
        if (allModelNotFound) {
            throw new Error(`ALL_PROVIDERS_REJECT_MODEL: no provider in the chain supports the requested model. ` +
                `Tried: ${available.map((e) => `${e.provider.name}/${e.provider.model}`).join(', ')}`);
        }
        throw new Error(`ALL_PROVIDERS_FAILED: all providers in the chain have been exhausted. ` +
            `Tried: ${available.map((e, i) => `${e.provider.name}/${e.provider.model} (${reasons[i] ?? 'unknown'})`).join(', ')}`);
    }
    async countTokens(messages) {
        const entry = this.activeEntry();
        if (!entry)
            return 0;
        return entry.provider.countTokens(messages);
    }
    // Returns the first non-cooled provider, or undefined if all are cooled.
    activeEntry() {
        const now = Date.now();
        return this.entries.find((e) => e.cooldownUntil <= now);
    }
}
