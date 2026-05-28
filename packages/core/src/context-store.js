export class ContextStore {
    store = new Map();
    get(key) {
        return this.store.get(key);
    }
    set(key, value) {
        this.store.set(key, value);
    }
    clear() {
        this.store.clear();
    }
    asContextMethods() {
        return {
            getContext: (key) => this.get(key),
            setContext: (key, value) => this.set(key, value),
        };
    }
}
