// FW-9 — process-local SteerSink implementation.
//
// One sink per AgentLoop turn surface (CLI REPL, gateway dispatcher). The
// sink is a plain FIFO with a soft cap; `push()` returns false when the cap
// is hit so the surface can drop or warn. Drain is atomic.

import type { SteerSink } from '@ethosagent/types';

export interface InMemorySteerSinkOptions {
  /** Max queued entries. Default 32 — beyond that, push() returns false. */
  cap?: number;
}

export class InMemorySteerSink implements SteerSink {
  private queue: string[] = [];
  private readonly cap: number;

  constructor(options: InMemorySteerSinkOptions = {}) {
    this.cap = options.cap ?? 32;
  }

  push(text: string): boolean {
    if (this.queue.length >= this.cap) return false;
    this.queue.push(text);
    return true;
  }

  drain(): string[] {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

  depth(): number {
    return this.queue.length;
  }
}
