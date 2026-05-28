export class DefaultLLMProviderRegistry {
    factories = new Map();
    register(name, factory) {
        if (this.factories.has(name)) {
            throw new Error(`LLM provider "${name}" is already registered`);
        }
        this.factories.set(name, factory);
    }
    get(name) {
        return this.factories.get(name);
    }
    list() {
        return [...this.factories.keys()];
    }
}
