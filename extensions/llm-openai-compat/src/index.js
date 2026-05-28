import OpenAI from 'openai';
// ---------------------------------------------------------------------------
// Gemini schema normalization
// Gemini via OpenAI-compat rejects several JSON Schema fields that OpenAI allows.
// ---------------------------------------------------------------------------
const GEMINI_STRIP_KEYS = new Set([
    'minLength',
    'maxLength',
    'pattern',
    'format',
    '$schema',
    'additionalProperties',
]);
export function normalizeGeminiSchema(schema) {
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (GEMINI_STRIP_KEYS.has(k))
            continue;
        // Gemini doesn't support array `type` (e.g. ["string", "null"])
        if (k === 'type' && Array.isArray(v)) {
            // Take the first non-null type
            const nonNull = v.find((t) => t !== 'null');
            if (nonNull)
                out.type = nonNull;
            continue;
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = normalizeGeminiSchema(v);
        }
        else if (Array.isArray(v)) {
            out[k] = v.map((item) => item && typeof item === 'object' && !Array.isArray(item)
                ? normalizeGeminiSchema(item)
                : item);
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
function isGeminiEndpoint(baseUrl) {
    return baseUrl.includes('generativelanguage.googleapis.com');
}
// ---------------------------------------------------------------------------
// Message conversion: our Message[] → OpenAI ChatCompletionMessageParam[]
// ---------------------------------------------------------------------------
// Exported for adapter tests — pure function over Message[] with no side effects.
export function toOpenAIMessages(messages, system) {
    const result = [];
    if (system) {
        result.push({ role: 'system', content: system });
    }
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            result.push({ role: msg.role, content: msg.content });
            continue;
        }
        // MessageContent[] — split into OpenAI format
        if (msg.role === 'user') {
            // Collect tool_result blocks as tool messages
            const toolResults = [];
            const textParts = [];
            // Vision / document parts (OpenAI Chat Completions multipart content).
            const mediaParts = [];
            for (const block of msg.content) {
                if (block.type === 'tool_result') {
                    toolResults.push({ tool_call_id: block.tool_use_id, content: block.content });
                }
                else if (block.type === 'text') {
                    textParts.push(block.text);
                }
                else if (block.type === 'image') {
                    // OpenAI Chat Completions vision: data: URI inside image_url.
                    mediaParts.push({
                        type: 'image_url',
                        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
                    });
                }
                else if (block.type === 'document') {
                    // OpenAI Chat Completions PDF: `file` content part with base64
                    // file_data + filename. Documented for the OpenAI API itself; some
                    // OpenAI-compat backends (Ollama, older Gemini surfaces) reject it
                    // — the capability table in vision_analyze (P2) gates by provider.
                    mediaParts.push({
                        type: 'file',
                        file: {
                            file_data: `data:${block.mediaType};base64,${block.data}`,
                            filename: 'document.pdf',
                        },
                    });
                }
            }
            // User content: if any media is present we MUST emit a multipart array
            // because OpenAI rejects an image_url block inside a plain string.
            if (mediaParts.length > 0) {
                const parts = [];
                for (const t of textParts)
                    parts.push({ type: 'text', text: t });
                for (const m of mediaParts)
                    parts.push(m);
                result.push({ role: 'user', content: parts });
            }
            else if (textParts.length > 0) {
                result.push({ role: 'user', content: textParts.join('\n') });
            }
            // Tool results as separate tool messages
            for (const tr of toolResults) {
                result.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
            }
        }
        else {
            // assistant — may have text + tool_use blocks
            const textParts = [];
            const toolCalls = [];
            for (const block of msg.content) {
                if (block.type === 'text') {
                    textParts.push(block.text);
                }
                else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: JSON.stringify(block.input) },
                    });
                }
            }
            result.push({
                role: 'assistant',
                content: textParts.join('\n') || null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            });
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Per-model pricing (USD per million tokens, approximate)
// ---------------------------------------------------------------------------
const OPENAI_PRICING = [
    // OpenAI
    { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6 },
    { prefix: 'gpt-4o', input: 2.5, output: 10 },
    { prefix: 'gpt-4-turbo', input: 10, output: 30 },
    { prefix: 'gpt-4', input: 30, output: 60 },
    { prefix: 'gpt-3.5-turbo', input: 0.5, output: 1.5 },
    // Google Gemini
    { prefix: 'gemini-2.0-flash', input: 0.1, output: 0.4 },
    { prefix: 'gemini-1.5-flash', input: 0.075, output: 0.3 },
    { prefix: 'gemini-1.5-pro', input: 1.25, output: 5.0 },
    // DeepSeek
    { prefix: 'deepseek-v3', input: 0.14, output: 0.28 },
    { prefix: 'deepseek-r1', input: 0.55, output: 2.19 },
    // Mistral
    { prefix: 'mistral-large', input: 2.0, output: 6.0 },
    { prefix: 'mistral-small', input: 0.1, output: 0.3 },
];
export function estimateCostOpenAI(model, inputTokens, outputTokens) {
    const p = OPENAI_PRICING.find((r) => model.toLowerCase().includes(r.prefix));
    if (!p)
        return 0; // unknown model — local/Ollama or unrecognised
    return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
// ---------------------------------------------------------------------------
// OpenAICompatProvider
// ---------------------------------------------------------------------------
export class OpenAICompatProvider {
    name;
    model;
    maxContextTokens;
    supportsCaching = false;
    supportsThinking = false;
    client;
    gemini;
    constructor(config) {
        this.name = config.name;
        this.model = config.model;
        this.maxContextTokens = config.maxContextTokens ?? 128_000;
        this.gemini = isGeminiEndpoint(config.baseUrl);
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
        });
    }
    async *complete(messages, tools, options) {
        const oaiMessages = toOpenAIMessages(messages, options.system);
        const oaiTools = tools.map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: this.gemini ? normalizeGeminiSchema(t.parameters) : t.parameters,
            },
        }));
        // Per-slice token computation (P1 observability) — best-effort, never blocks the call.
        let requestTokens;
        try {
            const systemText = options.system ?? '';
            const toolsText = oaiTools.length > 0 ? JSON.stringify(oaiTools) : '';
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
        const params = {
            model: effectiveModel,
            messages: oaiMessages,
            stream: true,
            stream_options: { include_usage: true },
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.topP !== undefined ? { top_p: options.topP } : {}),
            ...(options.seed !== undefined ? { seed: options.seed } : {}),
            ...(options.stopSequences ? { stop: options.stopSequences } : {}),
            ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
        };
        const stream = await this.client.chat.completions.create(params, {
            signal: options.abortSignal,
        });
        // Track streaming tool calls by index (OpenAI streams them as deltas)
        const pendingTools = new Map();
        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            // Usage chunk (comes on its own chunk when stream_options.include_usage=true)
            if (!choice && chunk.usage) {
                yield {
                    type: 'usage',
                    usage: {
                        inputTokens: chunk.usage.prompt_tokens,
                        outputTokens: chunk.usage.completion_tokens,
                        cacheReadTokens: 0,
                        cacheCreationTokens: 0,
                        estimatedCostUsd: estimateCostOpenAI(effectiveModel, chunk.usage.prompt_tokens, chunk.usage.completion_tokens),
                        requestTokens,
                    },
                };
                continue;
            }
            if (!choice)
                continue;
            const delta = choice.delta;
            if (delta.content) {
                yield { type: 'text_delta', text: delta.content };
            }
            // Stream tool call deltas
            for (const tc of delta.tool_calls ?? []) {
                const idx = tc.index;
                if (!pendingTools.has(idx)) {
                    // First delta for this tool call — has id and name
                    const id = tc.id ?? '';
                    const name = tc.function?.name ?? '';
                    pendingTools.set(idx, { id, name, args: '' });
                    yield { type: 'tool_use_start', toolCallId: id, toolName: name };
                }
                const pending = pendingTools.get(idx);
                if (pending && tc.function?.arguments) {
                    pending.args += tc.function.arguments;
                    yield {
                        type: 'tool_use_delta',
                        toolCallId: pending.id,
                        partialJson: tc.function.arguments,
                    };
                }
            }
            // Finish
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
                for (const [, tc] of pendingTools) {
                    yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: tc.args };
                }
                pendingTools.clear();
                yield {
                    type: 'done',
                    finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
                };
            }
        }
    }
    async countTokens(messages) {
        // OpenAI-compat providers don't expose a token-count endpoint.
        // Rough approximation: 1 token ≈ 4 chars.
        const chars = messages.reduce((sum, m) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return sum + content.length;
        }, 0);
        return Math.ceil(chars / 4);
    }
}
