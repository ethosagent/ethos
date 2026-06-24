import type {
  Logger,
  SecretsResolver,
  Storage,
  StorageFactory,
  StorageRegistry,
} from '@ethosagent/types';

export class DefaultStorageRegistry implements StorageRegistry {
  private readonly factories = new Map<string, StorageFactory>();
  private readonly instances = new Map<string, Storage>();

  register(name: string, factory: StorageFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Storage backend "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
    this.instances.delete(name);
  }

  async resolve(
    name: string,
    ctx: { config: Record<string, unknown>; secrets: SecretsResolver; logger: Logger },
  ): Promise<Storage> {
    const cached = this.instances.get(name);
    if (cached) return cached;
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Storage backend "${name}" is not registered`);
    }
    const instance = await factory(ctx);
    this.instances.set(name, instance);
    return instance;
  }

  get(name: string): Storage | undefined {
    return this.instances.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
