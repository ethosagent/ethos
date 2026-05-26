export class ContextStore {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }

  asContextMethods(): {
    getContext: <T>(key: string) => T | undefined;
    setContext: <T>(key: string, value: T) => void;
  } {
    return {
      getContext: <T>(key: string) => this.get<T>(key),
      setContext: <T>(key: string, value: T) => this.set(key, value),
    };
  }
}
