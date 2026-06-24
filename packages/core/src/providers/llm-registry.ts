import type { LLMProviderFactory, LLMProviderRegistry } from '@ethosagent/types';

export class DefaultLLMProviderRegistry implements LLMProviderRegistry {
  private readonly factories = new Map<string, LLMProviderFactory>();

  register(name: string, factory: LLMProviderFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`LLM provider "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
  }

  get(name: string): LLMProviderFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
