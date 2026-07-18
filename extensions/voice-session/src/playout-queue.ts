// Ordered playout of synthesized reply audio. Items are drained one at a time
// so audio plays in sentence order; `cancel()` flushes pending items and aborts
// the in-flight synthesis (barge-in). Tracks which sentences were actually
// played to their end, so the session can persist an honest interrupted reply.

import type { AudioFormat } from './types';

export interface PlayoutItem {
  /** The sentence text this audio corresponds to (for honest played-text tracking). */
  text: string;
  /** Lazily synthesizes the sentence; aborted via `signal` on cancel. */
  synthesize: (signal: AbortSignal) => AsyncIterable<{ audio: Uint8Array; format: AudioFormat }>;
}

export interface PlayoutQueueCallbacks {
  /** Called per audio chunk as it becomes available for playout. */
  onAudio: (audio: Uint8Array, format: AudioFormat, text: string) => void;
  /** Called once a sentence has fully played (all chunks emitted, not cancelled). */
  onSentencePlayed?: (text: string) => void;
  /** Called on a synthesis error that was not caused by cancellation. */
  onError?: (err: unknown) => void;
}

export class PlayoutQueue {
  private readonly callbacks: PlayoutQueueCallbacks;
  private queue: PlayoutItem[] = [];
  private draining = false;
  private cancelled = false;
  private controller: AbortController | null = null;
  private playedSentences: string[] = [];
  private drainPromise: Promise<void> | null = null;

  constructor(callbacks: PlayoutQueueCallbacks) {
    this.callbacks = callbacks;
  }

  enqueue(item: PlayoutItem): void {
    if (this.cancelled) return;
    this.queue.push(item);
    this.ensureDraining();
  }

  private ensureDraining(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainPromise = this.drain().finally(() => {
      this.draining = false;
    });
  }

  private async drain(): Promise<void> {
    while (!this.cancelled) {
      const item = this.queue.shift();
      if (!item) break;
      const controller = new AbortController();
      this.controller = controller;
      let completed = true;
      try {
        for await (const chunk of item.synthesize(controller.signal)) {
          if (this.cancelled) {
            completed = false;
            break;
          }
          this.callbacks.onAudio(chunk.audio, chunk.format, item.text);
        }
      } catch (err) {
        completed = false;
        if (!this.cancelled) this.callbacks.onError?.(err);
      }
      if (this.cancelled || !completed) break;
      this.playedSentences.push(item.text);
      this.callbacks.onSentencePlayed?.(item.text);
    }
    this.controller = null;
  }

  /** Flush pending items and abort in-flight synthesis (barge-in). */
  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    this.controller?.abort();
  }

  /** Resolves when the current drain (if any) finishes. */
  async idle(): Promise<void> {
    if (this.drainPromise) await this.drainPromise;
  }

  /** Sentences that fully played, in order. */
  playedText(): string[] {
    return [...this.playedSentences];
  }

  /** True while draining or with items still pending. */
  get active(): boolean {
    return this.draining || this.queue.length > 0;
  }

  /** Clear all state for a fresh turn. */
  reset(): void {
    this.cancelled = false;
    this.queue = [];
    this.playedSentences = [];
    this.controller = null;
  }
}
