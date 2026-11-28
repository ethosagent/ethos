import type { WorldGraphProviderFactory, WorldGraphProviderRegistry } from '@ethosagent/types';

export class DefaultWorldGraphProviderRegistry implements WorldGraphProviderRegistry {
  private readonly factories = new Map<string, WorldGraphProviderFactory>();

  register(name: string, factory: WorldGraphProviderFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`World graph provider "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
  }

  get(name: string): WorldGraphProviderFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
