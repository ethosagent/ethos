export class DefaultToolResultReducerRegistry {
    byName = new Map();
    register(reducer) {
        if (this.byName.has(reducer.toolName)) {
            throw new Error(`Reducer already registered for tool '${reducer.toolName}'`);
        }
        this.byName.set(reducer.toolName, reducer);
        return () => {
            this.byName.delete(reducer.toolName);
        };
    }
    get(toolName) {
        return this.byName.get(toolName);
    }
}
