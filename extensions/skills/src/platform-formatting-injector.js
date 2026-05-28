export class PlatformFormattingInjector {
    prompts;
    id = 'platform-formatting';
    priority = 90;
    constructor(prompts) {
        this.prompts = prompts;
    }
    shouldInject(ctx) {
        return this.prompts.has(ctx.platform);
    }
    async inject(ctx) {
        const prompt = this.prompts.get(ctx.platform);
        if (!prompt)
            return null;
        return { content: prompt, position: 'prepend' };
    }
}
