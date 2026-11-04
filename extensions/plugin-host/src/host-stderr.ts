import type { Logger } from '@ethosagent/types';

/** stderr is the plugin's console. Forwarded at debug, at most 50 lines per second. */
export class StderrForwarder {
  private tailText = '';
  private windowStart = 0;
  private lines = 0;

  constructor(
    private readonly pluginId: string,
    private readonly logger: Logger,
    private readonly now: () => number,
  ) {}

  push(chunk: Buffer): void {
    const text = chunk.toString('utf8');
    this.tailText = (this.tailText + text).slice(-2_000);
    const now = this.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.lines = 0;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      if (++this.lines > 50) return;
      this.logger.debug(`[plugin-host:${this.pluginId}] ${line}`, { component: 'plugin-host' });
    }
  }

  /** `: <last stderr>` for a start-failure message, or ''. */
  tail(): string {
    const t = this.tailText.trim();
    return t === '' ? '' : `: ${t.slice(0, 500)}`;
  }
}
