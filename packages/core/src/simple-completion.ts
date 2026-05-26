import type { LLMProvider } from '@ethosagent/types';
import type { SimpleCompletion, SimpleCompletionOptions } from '@ethosagent/types';

export class SimpleCompletionImpl implements SimpleCompletion {
  constructor(
    private readonly provider: LLMProvider,
    private readonly defaultModel: string,
    private readonly onUsage: (tokens: { input: number; output: number }) => void,
  ) {}

  async complete(prompt: string, options?: SimpleCompletionOptions): Promise<string> {
    const model = options?.model ?? this.defaultModel;
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = this.provider.complete(
      [{ role: 'user', content: prompt }],
      [],
      {
        system: options?.systemPrompt,
        maxTokens: options?.maxTokens ?? 1024,
        modelOverride: model !== this.provider.model ? model : undefined,
      },
    );

    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') text += chunk.text;
      if (chunk.type === 'usage') {
        inputTokens += chunk.usage.inputTokens;
        outputTokens += chunk.usage.outputTokens;
      }
    }

    this.onUsage({ input: inputTokens, output: outputTokens });
    return text;
  }
}
