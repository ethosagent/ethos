import type {
  PlayoutAnalyser,
  PlayoutBuffer,
  PlayoutContext,
  PlayoutSource,
  VoiceTransport,
  VoiceTransportStatus,
} from '@ethosagent/voice-client';
import type { VoiceClientFrame, VoiceServerFrame } from '@ethosagent/web-contracts';
import type { AppActiveSource, AudioBackend, InterruptionNotice, RecorderChunk } from '../engine';

/** An `AudioContext` stand-in with a hand-cranked clock (seconds). */
export class FakeContext implements PlayoutContext {
  currentTime = 0;
  readonly destination = { id: 'destination' };
  readonly starts: Array<{ at: number; duration: number }> = [];
  stops = 0;

  createBuffer(_channels: number, frames: number, sampleRate: number): PlayoutBuffer {
    return { duration: frames / sampleRate };
  }

  fillMono(): void {}

  createAnalyser(): PlayoutAnalyser {
    return { frequencyBinCount: 0, getByteFrequencyData: () => {}, connect: () => {} };
  }

  createBufferSource(): PlayoutSource {
    const source: PlayoutSource = {
      buffer: null,
      onended: null,
      connect: () => {},
      start: (at: number) => {
        this.starts.push({ at, duration: source.buffer?.duration ?? 0 });
      },
      stop: () => {
        this.stops++;
      },
    };
    return source;
  }

  decodeAudioData(): Promise<PlayoutBuffer> {
    return Promise.resolve({ duration: 0.5 });
  }
}

/** The native audio surface, driven by the test. */
export class FakeBackend implements AudioBackend {
  readonly playoutContext = new FakeContext();
  micAllowed = true;
  sessionActive = false;
  /** Make the next `setSessionActive(true)` reject (the phone call still holds it). */
  failActivation = false;
  recorderStarts = 0;
  recorderStops = 0;
  recording = false;
  closed = false;
  earcons = 0;
  configured = 0;
  preferred: { sampleRate: number; bufferLength: number } | null = null;
  private onChunk: ((chunk: RecorderChunk) => void) | null = null;
  private readonly interruptionListeners = new Set<(notice: InterruptionNotice) => void>();
  private readonly routeListeners = new Set<(reason: string) => void>();

  configureSession(): void {
    this.configured++;
  }

  setSessionActive(active: boolean): Promise<void> {
    if (active && this.failActivation) return Promise.reject(new Error('session busy'));
    this.sessionActive = active;
    return Promise.resolve();
  }

  requestMicPermission(): Promise<boolean> {
    return Promise.resolve(this.micAllowed);
  }

  startRecorder(
    preferred: { sampleRate: number; bufferLength: number },
    onChunk: (chunk: RecorderChunk) => void,
  ): Promise<void> {
    this.preferred = preferred;
    this.onChunk = onChunk;
    this.recording = true;
    this.recorderStarts++;
    return Promise.resolve();
  }

  stopRecorder(): Promise<void> {
    this.onChunk = null;
    this.recording = false;
    this.recorderStops++;
    return Promise.resolve();
  }

  playEarcon(): void {
    this.earcons++;
  }

  onInterruption(listener: (notice: InterruptionNotice) => void): () => void {
    this.interruptionListeners.add(listener);
    return () => this.interruptionListeners.delete(listener);
  }

  onRouteChange(listener: (reason: string) => void): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** The recorder delivers a chunk. */
  deliver(samples: Float32Array, sampleRate = 16_000): void {
    this.onChunk?.({ samples, sampleRate });
  }

  /** `ms` of a constant-amplitude tone at `sampleRate`. */
  tone(ms: number, amplitude: number, sampleRate = 16_000): void {
    const n = Math.round((sampleRate * ms) / 1000);
    this.deliver(
      Float32Array.from({ length: n }, (_, i) => (i % 2 === 0 ? amplitude : -amplitude)),
      sampleRate,
    );
  }

  interrupt(notice: InterruptionNotice): void {
    for (const listener of [...this.interruptionListeners]) listener(notice);
  }
}

export class FakeAppState implements AppActiveSource {
  private readonly listeners = new Set<() => void>();
  onActive(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  becomeActive(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A voice lane both ends of which the test drives. */
export class FakeTransport implements VoiceTransport {
  readonly sent: Array<{ frame: VoiceClientFrame; payload: Uint8Array }> = [];
  status: VoiceTransportStatus = 'closed';
  closed = false;
  private readonly frameListeners = new Set<
    (frame: VoiceServerFrame, payload: Uint8Array) => void
  >();
  private readonly statusListeners = new Set<(status: VoiceTransportStatus) => void>();

  connect(): Promise<void> {
    this.setStatus('open');
    return Promise.resolve();
  }

  send(frame: VoiceClientFrame, payload?: Uint8Array): void {
    this.sent.push({ frame, payload: payload ?? new Uint8Array() });
  }

  on(listener: (frame: VoiceServerFrame, payload: Uint8Array) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onStatus(listener: (status: VoiceTransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.setStatus('closed');
  }

  deliver(frame: VoiceServerFrame, payload: Uint8Array = new Uint8Array()): void {
    for (const listener of [...this.frameListeners]) listener(frame, payload);
  }

  setStatus(status: VoiceTransportStatus): void {
    this.status = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  frames(kind: VoiceClientFrame['t']): VoiceClientFrame[] {
    return this.sent.filter((s) => s.frame.t === kind).map((s) => s.frame);
  }
}

/** Let queued promise continuations run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
