import type { MemoryProviderFactory, MemoryProviderRegistry } from '@ethosagent/types';

export class DefaultMemoryProviderRegistry implements MemoryProviderRegistry {
  private readonly factories = new Map<string, MemoryProviderFactory>();

  register(name: string, factory: MemoryProviderFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Memory provider "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
  }

  get(name: string): MemoryProviderFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
