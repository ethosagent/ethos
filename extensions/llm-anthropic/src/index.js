import Anthropic from '@anthropic-ai/sdk';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function modelContextTokens(_model) {
    return 200_000; // all current Claude models
}
function isThinkingModel(model) {
    return (model.includes('claude-3-7') ||
        model.includes('claude-opus-4') ||
        model.includes('claude-sonnet-4'));
}
// Pricing per million tokens (approximate — update as pricing changes)
const PRICING = [
    { prefix: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    { prefix: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { prefix: 'claude-haiku-4', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
    { prefix: 'claude-3-7-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { prefix: 'claude-3-5-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { prefix: 'claude-3-5-haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
    { prefix: 'claude-3-opus', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
];
function estimateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens) {
    const p = PRICING.find((r) => model.includes(r.prefix)) ?? {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
    };
    const M = 1_000_000;
    return ((inputTokens * p.input +
        outputTokens * p.output +
        cacheReadTokens * p.cacheRead +
        cacheCreationTokens * p.cacheWrite) /
        M);
}
function toFinishReason(reason) {
    if (reason === 'tool_use')
        return 'tool_use';
    if (reason === 'max_tokens')
        return 'max_tokens';
    if (reason === 'stop_sequence')
        return 'stop_sequence';
    return 'end_turn';
}
function classifyError(err) {
    if (err instanceof Anthropic.AuthenticationError)
        return 'auth';
    if (err instanceof Anthropic.RateLimitError)
        return 'rate_limit';
    // APIStatusError covers 5xx and other HTTP errors
    if (err instanceof Anthropic.APIError) {
        const status = err.status;
        if (status === 529)
            return 'overloaded';
        if (status === 401 || status === 403)
            return 'auth';
        if (status === 429)
            return 'rate_limit';
    }
    return 'unknown';
}
// Convert our Message[] into Anthropic's MessageParam[]
export function toAnthropicMessages(messages) {
    return messages.map((msg) => {
        if (typeof msg.content === 'string') {
            return { role: msg.role, content: msg.content };
        }
        const blocks = msg.content.map(toAnthropicBlock);
        return { role: msg.role, content: blocks };
    });
}
function toAnthropicBlock(block) {
    switch (block.type) {
        case 'text':
            return { type: 'text', text: block.text };
        case 'tool_use':
            return {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input,
            };
        case 'tool_result':
            return {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: block.content,
                is_error: block.is_error,
            };
        case 'image':
            return {
                type: 'image',
                source: { type: 'base64', media_type: block.mediaType, data: block.data },
            };
        case 'document':
            // Anthropic PDF support (Base64PDFSource)
            return {
                type: 'document',
                source: { type: 'base64', media_type: block.mediaType, data: block.data },
            };
        default: {
            // Exhaustiveness guard — adding a new MessageContent variant without
            // teaching this mapper about it is a compile error, not silent fall-
            // through. The `never` cast surfaces the gap at the source.
            const _exhaustive = block;
            throw new Error(`unhandled MessageContent type: ${JSON.stringify(_exhaustive)}`);
        }
    }
}
// context_compression F2 — place `cache_control` markers on message-history
// breakpoints. Anthropic allows at most 4 markers total (system + messages);
// `maxAllowed` is what remains after the system prompt. Indices are clamped to
// the message list and de-duplicated. When there are more breakpoints than
// slots, the *shallowest* ones are dropped: caching pays off on the largest
// stable prefix, so the deepest boundaries are the ones worth keeping. The
// marker lands on the last content block of the message so the cached prefix
// ends exactly at that message boundary.
export function applyMessageCacheBreakpoints(messages, breakpoints, maxAllowed) {
    if (maxAllowed <= 0)
        return;
    const sorted = [...new Set(breakpoints)]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < messages.length)
        .sort((a, b) => a - b);
    // Keep the deepest `maxAllowed` boundaries, still applied in ascending order.
    const valid = sorted.slice(Math.max(0, sorted.length - maxAllowed));
    for (const idx of valid) {
        const msg = messages[idx];
        if (!msg)
            continue;
        if (typeof msg.content === 'string') {
            msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
            continue;
        }
        const last = msg.content[msg.content.length - 1];
        // Every block our `toAnthropicBlock` emits (text / tool_use / tool_result)
        // carries `cache_control`, but the SDK's `ContentBlockParam` union also
        // includes thinking blocks that do not — narrow via a structural cast.
        if (last) {
            last.cache_control = {
                type: 'ephemeral',
            };
        }
    }
}
// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------
export class AnthropicProvider {
    name = 'anthropic';
    model;
    maxContextTokens;
    supportsCaching = true;
    supportsThinking;
    client;
    constructor(config) {
        this.model = config.model;
        this.client = new Anthropic({
            apiKey: config.apiKey,
            ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        });
        this.maxContextTokens = modelContextTokens(config.model);
        this.supportsThinking = isThinkingModel(config.model);
    }
    async *complete(messages, tools, options) {
        const anthropicMessages = toAnthropicMessages(messages);
        const systemBlocks = options.system
            ? [
                {
                    type: 'text',
                    text: options.system,
                    ...(options.cacheSystemPrompt ? { cache_control: { type: 'ephemeral' } } : {}),
                },
            ]
            : undefined;
        // F2 — message-history cache breakpoints. The system prompt, when cached,
        // consumes one of Anthropic's 4 `cache_control` slots; the rest are
        // available for message-level breakpoints.
        if (options.cacheBreakpoints && options.cacheBreakpoints.length > 0) {
            const systemCached = systemBlocks !== undefined && options.cacheSystemPrompt === true;
            applyMessageCacheBreakpoints(anthropicMessages, options.cacheBreakpoints, 4 - (systemCached ? 1 : 0));
        }
        const anthropicTools = tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
        }));
        // Per-slice token computation (P1 observability) — best-effort, never blocks the call.
        let requestTokens;
        try {
            const systemText = options.system ?? '';
            const toolsText = anthropicTools.length > 0 ? JSON.stringify(anthropicTools) : '';
            const [sysTk, toolsTk, msgTk] = await Promise.all([
                systemText ? this.countTokens([{ role: 'user', content: systemText }]) : 0,
                toolsText ? this.countTokens([{ role: 'user', content: toolsText }]) : 0,
                this.countTokens(messages),
            ]);
            requestTokens = { system: sysTk, tools: toolsTk, messages: msgTk };
        }
        catch {
            // Best-effort: if token counting fails, requestTokens stays undefined.
        }
        const effectiveModel = options.modelOverride ?? this.model;
        // biome-ignore lint/suspicious/noExplicitAny: extended thinking params not yet in SDK types
        const params = {
            model: effectiveModel,
            max_tokens: options.maxTokens ?? 8096,
            messages: anthropicMessages,
            ...(systemBlocks ? { system: systemBlocks } : {}),
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
            ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
            ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        };
        if (isThinkingModel(effectiveModel) && options.thinkingBudget && options.thinkingBudget > 0) {
            params.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget };
        }
        let inputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let currentToolId = null;
        let currentBlockType = null;
        const stream = this.client.messages.stream(params, { signal: options.abortSignal });
        try {
            for await (const event of stream) {
                switch (event.type) {
                    case 'message_start': {
                        // Cast to access optional cache token fields (added with prompt caching beta)
                        const u = event.message.usage;
                        inputTokens = u.input_tokens;
                        cacheReadTokens = u.cache_read_input_tokens ?? 0;
                        cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
                        break;
                    }
                    case 'content_block_start': {
                        const { content_block } = event;
                        currentBlockType = content_block.type;
                        if (content_block.type === 'tool_use') {
                            currentToolId = content_block.id;
                            yield {
                                type: 'tool_use_start',
                                toolCallId: content_block.id,
                                toolName: content_block.name,
                            };
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        const { delta } = event;
                        if (delta.type === 'text_delta') {
                            yield { type: 'text_delta', text: delta.text };
                        }
                        else if (delta.type === 'input_json_delta' && currentToolId) {
                            yield {
                                type: 'tool_use_delta',
                                toolCallId: currentToolId,
                                partialJson: delta.partial_json,
                            };
                        }
                        else if (delta.type === 'thinking_delta') {
                            const thinking = delta.thinking;
                            yield { type: 'thinking_delta', thinking };
                        }
                        break;
                    }
                    case 'content_block_stop':
                        if (currentBlockType === 'tool_use' && currentToolId) {
                            yield { type: 'tool_use_end', toolCallId: currentToolId, inputJson: '' };
                            currentToolId = null;
                        }
                        currentBlockType = null;
                        break;
                    case 'message_delta': {
                        const outputTokens = event.usage?.output_tokens ?? 0;
                        yield {
                            type: 'usage',
                            usage: {
                                inputTokens,
                                outputTokens,
                                cacheReadTokens,
                                cacheCreationTokens,
                                estimatedCostUsd: estimateCost(effectiveModel, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
                                requestTokens,
                            },
                        };
                        if (event.delta.stop_reason) {
                            yield { type: 'done', finishReason: toFinishReason(event.delta.stop_reason) };
                        }
                        break;
                    }
                }
            }
        }
        finally {
            stream.abort();
        }
    }
    async countTokens(messages) {
        const result = await this.client.messages.countTokens({
            model: this.model,
            messages: toAnthropicMessages(messages),
        });
        return result.input_tokens;
    }
}
// ---------------------------------------------------------------------------
// AuthRotatingProvider — rotates API keys on auth/rate-limit failures
// ---------------------------------------------------------------------------
export class AuthRotatingProvider {
    name = 'anthropic';
    supportsCaching = true;
    providers;
    current = 0;
    constructor(profiles, model) {
        const sorted = [...profiles].sort((a, b) => b.priority - a.priority);
        this.providers = sorted.map((p) => new AnthropicProvider({ apiKey: p.apiKey, model, baseUrl: p.baseUrl }));
        if (this.providers.length === 0)
            throw new Error('AuthRotatingProvider: no profiles provided');
    }
    get model() {
        return this.providers[this.current]?.model ?? '';
    }
    get maxContextTokens() {
        return this.providers[this.current]?.maxContextTokens ?? 200_000;
    }
    get supportsThinking() {
        return this.providers[this.current]?.supportsThinking ?? false;
    }
    async *complete(messages, tools, options) {
        const startIdx = this.current;
        for (let attempt = 0; attempt < this.providers.length; attempt++) {
            const provider = this.providers[this.current];
            let yieldedAny = false;
            try {
                if (!provider)
                    throw new Error('AuthRotatingProvider: missing provider slot');
                for await (const chunk of provider.complete(messages, tools, options)) {
                    yieldedAny = true;
                    yield chunk;
                }
                return;
            }
            catch (err) {
                // Once the consumer has seen any chunk, failing over to a different
                // provider would emit a fresh stream from the start and corrupt the
                // assistant turn. Propagate the error instead.
                if (yieldedAny)
                    throw err;
                const reason = classifyError(err);
                if (reason === 'auth' || reason === 'rate_limit' || reason === 'overloaded') {
                    const next = (this.current + 1) % this.providers.length;
                    if (next === startIdx)
                        throw err; // full rotation exhausted
                    this.current = next;
                    continue;
                }
                throw err;
            }
        }
    }
    async countTokens(messages) {
        return this.providers[this.current]?.countTokens(messages) ?? Promise.resolve(0);
    }
}
