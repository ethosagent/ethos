export class SimpleCompletionImpl {
    provider;
    defaultModel;
    onUsage;
    constructor(provider, defaultModel, onUsage) {
        this.provider = provider;
        this.defaultModel = defaultModel;
        this.onUsage = onUsage;
    }
    async complete(prompt, options) {
        const model = options?.model ?? this.defaultModel;
        let text = '';
        let inputTokens = 0;
        let outputTokens = 0;
        const stream = this.provider.complete([{ role: 'user', content: prompt }], [], {
            system: options?.systemPrompt,
            maxTokens: options?.maxTokens ?? 1024,
            modelOverride: model !== this.provider.model ? model : undefined,
        });
        for await (const chunk of stream) {
            if (chunk.type === 'text_delta')
                text += chunk.text;
            if (chunk.type === 'usage') {
                inputTokens += chunk.usage.inputTokens;
                outputTokens += chunk.usage.outputTokens;
            }
        }
        this.onUsage({ input: inputTokens, output: outputTokens });
        return text;
    }
}
