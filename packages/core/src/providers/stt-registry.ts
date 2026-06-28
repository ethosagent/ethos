import type { SttProviderFactory, SttProviderRegistry } from '@ethosagent/types';

export class DefaultSttProviderRegistry implements SttProviderRegistry {
  private readonly factories = new Map<string, SttProviderFactory>();

  register(name: string, factory: SttProviderFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`STT provider "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
  }

  get(name: string): SttProviderFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
