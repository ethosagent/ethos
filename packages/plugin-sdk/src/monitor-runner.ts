import type { MonitorRunContext, PluginMonitorDef } from '@ethosagent/types';

export type MonitorStatus = 'running' | 'stopped' | 'crashed';

export class PluginMonitorRunner {
  private readonly defs = new Map<string, PluginMonitorDef>();
  private readonly running = new Map<string, AbortController>();
  private readonly statuses = new Map<string, MonitorStatus>();

  registerDef(def: PluginMonitorDef): void {
    this.defs.set(def.name, def);
  }

  start(
    name: string,
    params: Record<string, unknown>,
    ctx: Omit<MonitorRunContext, 'signal'>,
  ): void {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Monitor "${name}" not registered.`);
    this.stop(name);
    const controller = new AbortController();
    this.running.set(name, controller);
    this.statuses.set(name, 'running');
    const runCtx: MonitorRunContext = { ...ctx, signal: controller.signal };
    def
      .run(params, runCtx)
      .then(() => {
        if (!controller.signal.aborted) {
          this.statuses.set(name, 'stopped');
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          this.statuses.set(name, 'crashed');
          ctx.diagnostics?.error('monitor_crashed', {
            monitorName: name,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      });
  }

  stop(name: string): void {
    this.running.get(name)?.abort();
    this.running.delete(name);
    this.statuses.set(name, 'stopped');
  }

  stopAll(): void {
    for (const [name, controller] of this.running) {
      controller.abort();
      this.statuses.set(name, 'stopped');
    }
    this.running.clear();
  }

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  getDef(name: string): PluginMonitorDef | undefined {
    return this.defs.get(name);
  }

  /** v2.2 — Return the current status of a monitor. */
  getStatus(name: string): MonitorStatus | undefined {
    return this.statuses.get(name);
  }

  /** v2.2 — Return names of all monitors in the 'crashed' state. */
  getCrashedMonitors(): string[] {
    return [...this.statuses.entries()]
      .filter(([, s]) => s === 'crashed')
      .map(([n]) => n);
  }
}
