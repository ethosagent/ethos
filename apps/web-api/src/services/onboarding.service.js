import { validateUrl } from '@ethosagent/core';
import { EthosError } from '@ethosagent/types';
const MODELS_TIMEOUT_MS = 8_000;
const COMPLETION_TIMEOUT_MS = 10_000;
export class OnboardingService {
    opts;
    fetchFn;
    constructor(opts) {
        this.opts = opts;
        this.fetchFn = opts.fetchFn ?? fetch;
    }
    async state() {
        const raw = await this.opts.config.read();
        const hasProvider = !!(raw?.provider && raw.apiKey);
        const personalityId = raw?.personality ?? null;
        if (!raw)
            return { step: 'welcome', hasProvider: false, selectedPersonalityId: null };
        if (!hasProvider)
            return { step: 'provider', hasProvider: false, selectedPersonalityId: null };
        if (!personalityId)
            return { step: 'personality', hasProvider, selectedPersonalityId: null };
        // Provider + personality both set → done. Front-end may still show the
        // "first turn" magic moment but that's a UI concern, not a config gate.
        return { step: 'done', hasProvider, selectedPersonalityId: personalityId };
    }
    async validateProvider(input) {
        try {
            const models = await this.fetchModels(input);
            if (input.provider === 'ollama') {
                return { ok: true, models, error: null, completionTested: false };
            }
            const chatModel = this.pickChatModel(input.provider, models);
            if (!chatModel) {
                return { ok: true, models, error: null, completionTested: false };
            }
            try {
                await this.testCompletion(input, chatModel);
                return { ok: true, models, error: null, completionTested: true };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const isBillingError = message.includes('no credits');
                if (isBillingError) {
                    return { ok: false, models, error: message, completionTested: false };
                }
                return { ok: true, models, error: null, completionTested: false };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, models: null, error: message, completionTested: false };
        }
    }
    async complete(input) {
        if (!this.opts.personalities.get(input.personalityId)) {
            throw new EthosError({
                code: 'PERSONALITY_NOT_FOUND',
                cause: `Personality "${input.personalityId}" not found`,
                action: 'Pick from the list returned by `personalities.list`.',
            });
        }
        await this.opts.config.update({
            provider: input.provider,
            model: input.model,
            apiKey: input.apiKey,
            personality: input.personalityId,
            ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        });
    }
    // ---------------------------------------------------------------------------
    // Chat model selection
    // ---------------------------------------------------------------------------
    pickChatModel(provider, models) {
        if (models.length === 0)
            return null;
        switch (provider) {
            case 'anthropic':
                return models.find((m) => m.startsWith('claude-')) ?? models[0] ?? null;
            case 'openai':
                return (models.find((m) => m.startsWith('gpt-') ||
                    m.startsWith('o1-') ||
                    m.startsWith('o3-') ||
                    m.startsWith('o4-')) ??
                    models[0] ??
                    null);
            default:
                return (models.find((m) => m.includes('chat') ||
                    m.includes('gpt') ||
                    m.includes('claude') ||
                    m.includes('llama') ||
                    m.includes('mistral') ||
                    m.includes('gemma')) ??
                    models[0] ??
                    null);
        }
    }
    // ---------------------------------------------------------------------------
    // Provider model-list fetchers
    // ---------------------------------------------------------------------------
    async fetchModels(input) {
        if (input.baseUrl) {
            validateUrl(input.baseUrl, {
                allowLocalhost: input.provider === 'ollama',
            });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
        try {
            switch (input.provider) {
                case 'anthropic':
                    return await this.anthropicModels(input.apiKey, controller.signal);
                case 'ollama':
                    return await this.ollamaModels(input.baseUrl ?? 'http://localhost:11434', controller.signal);
                case 'openrouter':
                    return await this.openAiCompatibleModels(input.baseUrl ?? 'https://openrouter.ai/api/v1', input.apiKey, controller.signal);
                case 'openai':
                    return await this.openAiCompatibleModels(input.baseUrl ?? 'https://api.openai.com/v1', input.apiKey, controller.signal);
                case 'openai-compat':
                    if (!input.baseUrl)
                        throw new Error('baseUrl required for openai-compat');
                    return await this.openAiCompatibleModels(input.baseUrl, input.apiKey, controller.signal);
                case 'azure':
                    if (!input.baseUrl)
                        throw new Error('baseUrl required for azure');
                    return await this.openAiCompatibleModels(input.baseUrl, input.apiKey, controller.signal);
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    async anthropicModels(apiKey, signal) {
        const res = await this.fetchFn('https://api.anthropic.com/v1/models', {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            signal,
        });
        if (!res.ok)
            throw new Error(`anthropic returned ${res.status}`);
        const body = (await res.json());
        return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    }
    async openAiCompatibleModels(baseUrl, apiKey, signal) {
        const url = `${baseUrl.replace(/\/$/, '')}/models`;
        validateUrl(url);
        const res = await this.fetchFn(url, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal,
        });
        if (!res.ok)
            throw new Error(`${baseUrl} returned ${res.status}`);
        const body = (await res.json());
        return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    }
    async ollamaModels(baseUrl, signal) {
        const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
        validateUrl(url, { allowLocalhost: true });
        const res = await this.fetchFn(url, { signal });
        if (!res.ok)
            throw new Error(`ollama returned ${res.status}`);
        const body = (await res.json());
        return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    }
    // ---------------------------------------------------------------------------
    // Completion test
    // ---------------------------------------------------------------------------
    async testCompletion(input, model) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
        try {
            switch (input.provider) {
                case 'ollama':
                    return;
                case 'anthropic':
                    await this.anthropicCompletion(input.apiKey, model, controller.signal);
                    return;
                default:
                    await this.openAiCompletion(this.resolveBaseUrl(input), input.apiKey, model, controller.signal);
                    return;
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    resolveBaseUrl(input) {
        switch (input.provider) {
            case 'openrouter':
                return input.baseUrl ?? 'https://openrouter.ai/api/v1';
            case 'openai':
                return input.baseUrl ?? 'https://api.openai.com/v1';
            case 'openai-compat':
            case 'azure':
                return input.baseUrl ?? '';
            default:
                return input.baseUrl ?? '';
        }
    }
    async anthropicCompletion(apiKey, model, signal) {
        const res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }],
            }),
            signal,
        });
        if (!res.ok) {
            throw await this.translateCompletionError(res, 'anthropic');
        }
    }
    async openAiCompletion(baseUrl, apiKey, model, signal) {
        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
        const res = await this.fetchFn(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }],
            }),
            signal,
        });
        if (!res.ok) {
            throw await this.translateCompletionError(res, baseUrl);
        }
    }
    async translateCompletionError(res, provider) {
        let bodyText = '';
        try {
            bodyText = await res.text();
        }
        catch {
            /* ignore */
        }
        const lower = bodyText.toLowerCase();
        if (res.status === 402 ||
            lower.includes('insufficient_quota') ||
            lower.includes('billing') ||
            lower.includes('credit')) {
            return new Error("Your API key is valid but your account has no credits. Add credits at your provider's billing page.");
        }
        if (res.status === 403 ||
            lower.includes('model_not_found') ||
            lower.includes('access_denied')) {
            return new Error('This model is not available on your plan. Try selecting a different model.');
        }
        return new Error(`API key validated, but a test message failed: ${provider} returned ${res.status}. You may still proceed, but the agent may not respond.`);
    }
}
