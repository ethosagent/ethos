import type { TtsProviderFactory, TtsProviderRegistry } from '@ethosagent/types';

export class DefaultTtsProviderRegistry implements TtsProviderRegistry {
  private readonly factories = new Map<string, TtsProviderFactory>();

  register(name: string, factory: TtsProviderFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`TTS provider "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
  }

  get(name: string): TtsProviderFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
