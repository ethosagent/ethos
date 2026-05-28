// Generic plugin registry — adapted from praxis PluginRegistry pattern.
// Each subsystem (tools, channels, memory backends) gets its own instance.
export class PluginRegistry {
    factories = new Map();
    register(type, factory) {
        this.factories.set(type, factory);
    }
    create(type, config) {
        const factory = this.factories.get(type);
        if (!factory) {
            throw new Error(`Unknown plugin type: "${type}". Registered: ${[...this.factories.keys()].join(', ')}`);
        }
        const instance = factory(config);
        if (!instance) {
            throw new Error(`Plugin factory for "${type}" returned null`);
        }
        return instance;
    }
    has(type) {
        return this.factories.has(type);
    }
    types() {
        return [...this.factories.keys()];
    }
}
