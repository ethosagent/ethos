import type { ContextInjector, InjectionResult, PromptContext } from '@ethosagent/types';

export class PlatformFormattingInjector implements ContextInjector {
  readonly id = 'platform-formatting';
  readonly priority = 90;

  constructor(private readonly prompts: Map<string, string>) {}

  shouldInject(ctx: PromptContext): boolean {
    return this.prompts.has(ctx.platform);
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const prompt = this.prompts.get(ctx.platform);
    if (!prompt) return null;
    return { content: prompt, position: 'prepend' };
  }
}
