export class DiagnosticStore {
  events = new Map();
  metrics = new Map();
  maxPerPlugin;
  constructor(maxPerPlugin = 500) {
    this.maxPerPlugin = maxPerPlugin;
  }
  pushEvent(event) {
    if (!this.events.has(event.pluginId)) this.events.set(event.pluginId, []);
    const buf = this.events.get(event.pluginId);
    if (buf) {
      buf.push(event);
      if (buf.length > this.maxPerPlugin) buf.shift();
    }
  }
  pushMetric(metric) {
    if (!this.metrics.has(metric.pluginId)) this.metrics.set(metric.pluginId, []);
    const buf = this.metrics.get(metric.pluginId);
    if (buf) {
      buf.push(metric);
      if (buf.length > this.maxPerPlugin) buf.shift();
    }
  }
  getEvents(pluginId, opts) {
    let buf = this.events.get(pluginId) ?? [];
    if (opts?.level) buf = buf.filter((e) => e.level === opts.level);
    return opts?.limit ? buf.slice(-opts.limit) : [...buf];
  }
  getMetrics(pluginId, limit) {
    const buf = this.metrics.get(pluginId) ?? [];
    return limit ? buf.slice(-limit) : [...buf];
  }
  pluginIds() {
    return [...new Set([...this.events.keys(), ...this.metrics.keys()])];
  }
  clearPlugin(pluginId) {
    this.events.delete(pluginId);
    this.metrics.delete(pluginId);
  }
}
