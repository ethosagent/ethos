import type {
  ExecutionBackend,
  ExecutionBackendConfig,
  ExecutionBackendFactory,
  ExecutionBackendRegistry,
  Logger,
  SecretsResolver,
} from '@ethosagent/types';

/**
 * Default execution-backend registry.
 *
 * Lifecycle: register a factory → resolve() it into a concrete instance →
 * get() the cached instance. Two maps are required because get() must return
 * an INSTANCE (not a factory) and factories may be async — so resolution is a
 * distinct step from registration, and resolved instances are cached.
 */
export class DefaultExecutionBackendRegistry implements ExecutionBackendRegistry {
  private readonly factories = new Map<string, ExecutionBackendFactory>();
  private readonly instances = new Map<string, ExecutionBackend>();

  register(name: string, factory: ExecutionBackendFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Execution backend "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  async resolve(
    name: string,
    ctx: { config: ExecutionBackendConfig; secrets: SecretsResolver; logger: Logger },
  ): Promise<ExecutionBackend> {
    const cached = this.instances.get(name);
    if (cached) return cached;
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Execution backend "${name}" is not registered`);
    }
    const instance = await factory(ctx);
    this.instances.set(name, instance);
    return instance;
  }

  get(name: string): ExecutionBackend | undefined {
    return this.instances.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
