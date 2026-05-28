export class PluginMonitorRunner {
    defs = new Map();
    running = new Map();
    statuses = new Map();
    registerDef(def) {
        this.defs.set(def.name, def);
    }
    start(name, params, ctx) {
        const def = this.defs.get(name);
        if (!def)
            throw new Error(`Monitor "${name}" not registered.`);
        this.stop(name);
        const controller = new AbortController();
        this.running.set(name, controller);
        this.statuses.set(name, 'running');
        const runCtx = { ...ctx, signal: controller.signal };
        def
            .run(params, runCtx)
            .then(() => {
            if (!controller.signal.aborted) {
                this.running.delete(name);
                this.statuses.set(name, 'stopped');
            }
        })
            .catch((err) => {
            if (!controller.signal.aborted) {
                this.running.delete(name);
                this.statuses.set(name, 'crashed');
                ctx.diagnostics?.error('monitor_crashed', {
                    monitorName: name,
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined,
                });
            }
        });
    }
    stop(name) {
        this.running.get(name)?.abort();
        this.running.delete(name);
        this.statuses.set(name, 'stopped');
    }
    stopAll() {
        for (const [name, controller] of this.running) {
            controller.abort();
            this.statuses.set(name, 'stopped');
        }
        this.running.clear();
    }
    isRunning(name) {
        return this.running.has(name);
    }
    getDef(name) {
        return this.defs.get(name);
    }
    /** v2.2 — Return the current status of a monitor. */
    getStatus(name) {
        return this.statuses.get(name);
    }
    /** v2.2 — Return names of all monitors in the 'crashed' state. */
    getCrashedMonitors() {
        return [...this.statuses.entries()].filter(([, s]) => s === 'crashed').map(([n]) => n);
    }
}
