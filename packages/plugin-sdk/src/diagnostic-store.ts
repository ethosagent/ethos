import type { DiagnosticEvent, DiagnosticLevel, DiagnosticMetric } from '@ethosagent/types';

export class DiagnosticStore {
  private readonly events = new Map<string, DiagnosticEvent[]>();
  private readonly metrics = new Map<string, DiagnosticMetric[]>();
  private readonly maxPerPlugin: number;

  constructor(maxPerPlugin = 500) {
    this.maxPerPlugin = maxPerPlugin;
  }

  pushEvent(event: DiagnosticEvent): void {
    if (!this.events.has(event.pluginId)) this.events.set(event.pluginId, []);
    const buf = this.events.get(event.pluginId);
    if (buf) {
      buf.push(event);
      if (buf.length > this.maxPerPlugin) buf.shift();
    }
  }

  pushMetric(metric: DiagnosticMetric): void {
    if (!this.metrics.has(metric.pluginId)) this.metrics.set(metric.pluginId, []);
    const buf = this.metrics.get(metric.pluginId);
    if (buf) {
      buf.push(metric);
      if (buf.length > this.maxPerPlugin) buf.shift();
    }
  }

  getEvents(
    pluginId: string,
    opts?: { limit?: number; level?: DiagnosticLevel },
  ): DiagnosticEvent[] {
    let buf = this.events.get(pluginId) ?? [];
    if (opts?.level) buf = buf.filter((e) => e.level === opts.level);
    return opts?.limit ? buf.slice(-opts.limit) : [...buf];
  }

  getMetrics(pluginId: string, limit?: number): DiagnosticMetric[] {
    const buf = this.metrics.get(pluginId) ?? [];
    return limit ? buf.slice(-limit) : [...buf];
  }

  pluginIds(): string[] {
    return [...new Set([...this.events.keys(), ...this.metrics.keys()])];
  }

  clearPlugin(pluginId: string): void {
    this.events.delete(pluginId);
    this.metrics.delete(pluginId);
  }
}
