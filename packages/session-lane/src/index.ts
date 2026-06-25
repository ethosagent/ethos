// ---------------------------------------------------------------------------
// SessionLane — serialises concurrent messages for the same chat
// ---------------------------------------------------------------------------

interface LaneTask {
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class SessionLane {
  private readonly queue: LaneTask[] = [];
  private processing = false;
  private currentAbort: AbortController | null = null;

  enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject });
      void this.drain();
    });
  }

  /** Abort the running task and drop everything queued behind it. */
  abort(): void {
    this.currentAbort?.abort();
    const dropped = this.queue.splice(0);
    for (const item of dropped) {
      item.reject(new Error('aborted'));
    }
  }

  get length(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.currentAbort = new AbortController();
      try {
        await item.run(this.currentAbort.signal);
        item.resolve();
      } catch (err) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.currentAbort = null;
    this.processing = false;
  }
}
