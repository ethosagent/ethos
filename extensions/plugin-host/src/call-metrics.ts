/** Window cap: a busy host keeps the latest samples, so memory stays bounded. */
const MAX_SAMPLES = 4096;

export interface CallWindow {
  calls: number;
  p50_ms: number;
  p95_ms: number;
  /** Bytes the parent received from the host. */
  bytes_in: number;
  /** Bytes the parent sent to the host. */
  bytes_out: number;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

/** Per-host IPC call counters for one `plugin_host.stats` window. */
export class CallMetrics {
  private samples: number[] = [];
  private calls = 0;
  private bytesIn = 0;
  private bytesOut = 0;

  record(ipcMs: number, reqBytes: number, resBytes: number): void {
    if (this.samples.length < MAX_SAMPLES) this.samples.push(ipcMs);
    else this.samples[this.calls % MAX_SAMPLES] = ipcMs;
    this.calls++;
    this.bytesOut += reqBytes;
    this.bytesIn += resBytes;
  }

  /** Returns the window and starts a new one. */
  drain(): CallWindow {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const out: CallWindow = {
      calls: this.calls,
      p50_ms: round(percentile(sorted, 0.5)),
      p95_ms: round(percentile(sorted, 0.95)),
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
    };
    this.samples = [];
    this.calls = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    return out;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
