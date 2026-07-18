// Turns a stream of VAD speech/silence flags into utterance boundaries: once
// speech has been observed, N ms of trailing silence commits the utterance.
// Uses an injected clock so tests are deterministic.

export interface EndpointDetectorConfig {
  /** Trailing silence (ms) that commits an utterance after speech. Default 400. */
  silenceMs?: number;
  /** Clock source; defaults to performance.now. Inject for deterministic tests. */
  now?: () => number;
}

export class EndpointDetector {
  private readonly silenceMs: number;
  private readonly now: () => number;
  private hadSpeech = false;
  private lastSpeechAt = 0;

  constructor(config: EndpointDetectorConfig = {}) {
    this.silenceMs = config.silenceMs ?? 400;
    this.now = config.now ?? (() => performance.now());
  }

  /**
   * Feed one frame's speech flag. Returns `{ committed: true }` exactly once
   * per utterance, on the frame where trailing silence first exceeds the
   * threshold. After a commit the detector re-arms for the next utterance.
   */
  process(speech: boolean): { committed: boolean } {
    if (speech) {
      this.hadSpeech = true;
      this.lastSpeechAt = this.now();
      return { committed: false };
    }
    if (this.hadSpeech && this.now() - this.lastSpeechAt >= this.silenceMs) {
      this.hadSpeech = false;
      return { committed: true };
    }
    return { committed: false };
  }

  /** True while an utterance is in progress (speech seen, not yet committed). */
  get active(): boolean {
    return this.hadSpeech;
  }

  reset(): void {
    this.hadSpeech = false;
  }
}
