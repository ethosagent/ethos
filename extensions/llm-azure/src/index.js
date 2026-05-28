import { estimateCostOpenAI, toOpenAIMessages } from '@ethosagent/llm-openai-compat';
import { AzureOpenAI } from 'openai';
// ---------------------------------------------------------------------------
// AzureOpenAIProvider
// ---------------------------------------------------------------------------
//
// Azure OpenAI is wire-compatible with the OpenAI Chat Completions API but
// differs in two places that prevent reusing `OpenAICompatProvider` directly:
//
//   1. Auth: Azure uses the `api-key` header instead of `Authorization: Bearer`.
//   2. Routing: every request needs an `api-version` query param and is
//      addressed by deployment name, not by model id.
//
// The `AzureOpenAI` client (shipped inside the same `openai` package) handles
// both transparently. The streaming + tool-call translation logic is otherwise
// identical to OpenAI Chat Completions, so we share `toOpenAIMessages` and
// `estimateCostOpenAI` from the sibling extension.
export class AzureOpenAIProvider {
    name;
    model;
    maxContextTokens;
    supportsCaching = false;
    supportsThinking = false;
    client;
    constructor(config) {
        this.name = config.name;
        this.model = config.model;
        this.maxContextTokens = config.maxContextTokens ?? 128_000;
        this.client = new AzureOpenAI({
            apiKey: config.apiKey,
            endpoint: config.endpoint,
            apiVersion: config.apiVersion,
        });
    }
    async *complete(messages, tools, options) {
        const oaiMessages = toOpenAIMessages(messages, options.system);
        const oaiTools = tools.map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
        const effectiveModel = options.modelOverride ?? this.model;
        const params = {
            model: effectiveModel,
            messages: oaiMessages,
            stream: true,
            stream_options: { include_usage: true },
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.stopSequences ? { stop: options.stopSequences } : {}),
            ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
        };
        const stream = await this.client.chat.completions.create(params, {
            signal: options.abortSignal,
        });
        const pendingTools = new Map();
        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice && chunk.usage) {
                yield {
                    type: 'usage',
                    usage: {
                        inputTokens: chunk.usage.prompt_tokens,
                        outputTokens: chunk.usage.completion_tokens,
                        cacheReadTokens: 0,
                        cacheCreationTokens: 0,
                        estimatedCostUsd: estimateCostOpenAI(effectiveModel, chunk.usage.prompt_tokens, chunk.usage.completion_tokens),
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
            for (const tc of delta.tool_calls ?? []) {
                const idx = tc.index;
                if (!pendingTools.has(idx)) {
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
        // Azure doesn't expose a token-count endpoint either; same ~4 chars/token
        // approximation as OpenAICompatProvider.
        const chars = messages.reduce((sum, m) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return sum + content.length;
        }, 0);
        return Math.ceil(chars / 4);
    }
}
