import {
  AbsolutePlayout,
  CALL_MOTION,
  type EndpointerEvent,
  type PlayoutAnalyser,
  type PlayoutBuffer,
  type PlayoutContext,
  type PlayoutSource,
  rms,
  smoothLevel,
  type VoiceCaptureIo,
} from '@ethosagent/voice-client';
import type * as AudioApi from 'react-native-audio-api';
import {
  type InterruptionEffect,
  type InterruptionInput,
  type InterruptionState,
  interruptionStep,
} from './interruption';
import {
  createFramer,
  createResampler,
  floatToInt16,
  frameSamples,
  levelFromRms,
  type Resampler,
  resampleClip,
  resampledLength,
} from './pcm';

// The phone's audio engine for a call: mic capture, playout, the audio session
// and interruptions. The ONLY file that touches `react-native-audio-api`, and
// only through `loadAudioBackend()`'s dynamic import — so Expo Go and every
// non-call screen never evaluate the native module. The `import type` above is
// erased at compile time.
//
// Split in two so the half with decisions in it tests in node:
//
//   AudioBackend       the native surface, as narrow as the engine needs.
//                      `loadAudioBackend()` builds it over the library; tests
//                      pass a fake.
//   createVoiceEngine  everything else — resampling to the lane's rate, 20 ms
//                      framing, RMS, mute, and the interruption state machine
//                      (`./interruption.ts`) — over whatever backend it is given.

/** One chunk from the recorder: float32 mono at the rate the HARDWARE settled
 *  on, which is not necessarily the rate that was asked for. */
export interface RecorderChunk {
  samples: Float32Array;
  sampleRate: number;
}

export interface InterruptionNotice {
  type: 'began' | 'ended';
  shouldResume: boolean;
}

export interface AudioBackend {
  /** playAndRecord + voiceChat, speaker by default, Bluetooth headsets allowed. */
  configureSession(): void;
  setSessionActive(active: boolean): Promise<void>;
  /** True when the mic is (now) allowed. */
  requestMicPermission(): Promise<boolean>;
  startRecorder(
    preferred: { sampleRate: number; bufferLength: number },
    onChunk: (chunk: RecorderChunk) => void,
  ): Promise<void>;
  stopRecorder(): Promise<void>;
  /** The output side, shaped for `AbsolutePlayout`. */
  readonly playoutContext: PlayoutContext;
  /** The output context's rate. Buffers at any other rate are resampled to it
   *  before they reach the context (see `resampleClip`). */
  readonly outputSampleRate: number;
  /** A short acknowledgement tone. Best-effort. */
  playEarcon(): void;
  onInterruption(listener: (notice: InterruptionNotice) => void): () => void;
  onRouteChange(listener: (reason: string) => void): () => void;
  /** Release the output context. */
  close(): Promise<void>;
}

/** AppState, reduced to the one edge the engine needs. */
export interface AppActiveSource {
  onActive(listener: () => void): () => void;
}

export type EngineEvent =
  /** The OS took the audio session (phone call, Siri, alarm). */
  | { type: 'held' }
  /** The session came back and the uplink is live again. */
  | { type: 'resumed' }
  /** The output or input route changed (headset in or out, Bluetooth). */
  | { type: 'route'; reason: string }
  /** Resuming failed; the call stays held until the app is active again. */
  | { type: 'error'; code: 'resume_failed'; message: string }
  /** An encoded clip could not be decoded, so its audio was lost. Emitted once
   *  per MIME type per engine (an engine lives for one call). */
  | {
      type: 'error';
      code: 'undecodable_audio';
      mime: string;
      /** For the user: which audio this phone cannot play. */
      message: string;
      /** The decoder's own reason, for the trace. */
      detail: string;
    };

/** A capture the shared clients drive. The phone has no `MediaStream`, so
 *  `micStream()` is always null and the meter reads `micLevel()`. */
export type EngineCapture = VoiceCaptureIo<null> & { micLevel(): number };

export interface VoiceEngine {
  /** PCM16 mono frames of `FRAME_MS` at `sampleRate` — what the lane expects. */
  readonly capture: EngineCapture;
  readonly playout: AbsolutePlayout;
  /** Every uplinked frame with its RMS (0..1), for barge-in and the trace. */
  onFrame(listener: (frame: Int16Array, rms: number) => void): () => void;
  on(listener: (event: EngineEvent) => void): () => void;
  /** True while the OS holds the session. */
  readonly held: boolean;
}

export interface VoiceEngineOptions {
  backend: AudioBackend;
  /** The rate the lane is told in `hello` (or the realtime provider requires). */
  sampleRate: number;
  appState?: AppActiveSource;
}

/** Thrown when the mic is refused. Named like the browser's refusal so the
 *  shared `classifyVoiceStartError` maps it to the mic-denied guidance. */
export class MicPermissionError extends Error {
  constructor() {
    super('Microphone access was refused.');
    this.name = 'NotAllowedError';
  }
}

export function createVoiceEngine(opts: VoiceEngineOptions): VoiceEngine {
  const { backend, sampleRate } = opts;
  const size = frameSamples(sampleRate);
  const framer = createFramer(size);

  const captureListeners = new Set<(event: EndpointerEvent) => void>();
  const frameListeners = new Set<(frame: Int16Array, rms: number) => void>();
  const eventListeners = new Set<(event: EngineEvent) => void>();
  const emitEvent = (event: EngineEvent): void => {
    for (const listener of [...eventListeners]) listener(event);
  };

  const reportedMimes = new Set<string>();
  const playout = new AbsolutePlayout(
    adaptPlayoutContext(backend.playoutContext, backend.outputSampleRate, (mime, err) => {
      if (reportedMimes.has(mime)) return;
      reportedMimes.add(mime);
      emitEvent({
        type: 'error',
        code: 'undecodable_audio',
        mime,
        message: `Can't play ${mime} on this phone.`,
        detail: err instanceof Error && err.message ? err.message : String(err),
      });
    }),
  );

  let resampler: Resampler | null = null;
  let micEnabled = true;
  let level = 0;
  let machine: InterruptionState = 'idle';
  let held = false;
  let unsubs: Array<() => void> = [];
  /** Effects run one batch at a time: a `began` landing mid-resume waits. */
  let effectChain: Promise<void> = Promise.resolve();

  const uplinkOpen = (): boolean => micEnabled && !held && machine !== 'idle';

  const onChunk = (chunk: RecorderChunk): void => {
    if (!uplinkOpen()) return;
    // A route change (Bluetooth HFP is 8/16 kHz) changes the hardware rate
    // mid-call; the converter is rebuilt and any partial frame dropped.
    if (!resampler || resampler.fromRate !== chunk.sampleRate) {
      resampler = createResampler(chunk.sampleRate, sampleRate);
      framer.reset();
    }
    const pcm = floatToInt16(resampler.push(chunk.samples));
    for (const frame of framer.push(pcm)) {
      const frameRms = rms(frame);
      level = smoothLevel(level, levelFromRms(frameRms), CALL_MOTION.smoothing);
      for (const listener of [...frameListeners]) listener(frame, frameRms);
      for (const listener of [...captureListeners]) listener({ type: 'frame', data: frame });
    }
  };

  const startRecorder = (): Promise<void> =>
    backend.startRecorder({ sampleRate, bufferLength: size }, onChunk);

  const perform = async (effect: InterruptionEffect): Promise<void> => {
    switch (effect) {
      case 'stop-playout':
        playout.stop();
        return;
      case 'mute-uplink':
        held = true;
        level = 0;
        framer.reset();
        return;
      case 'emit-held':
        emitEvent({ type: 'held' });
        return;
      case 'reactivate-session':
        await backend.setSessionActive(true);
        return;
      case 'restart-recorder':
        await backend.stopRecorder().catch(() => {});
        resampler = null;
        await startRecorder();
        return;
      case 'unmute-uplink':
        held = false;
        return;
      case 'emit-resumed':
        emitEvent({ type: 'resumed' });
        return;
    }
  };

  const feed = (input: InterruptionInput): void => {
    const step = interruptionStep(machine, input);
    machine = step.state;
    if (step.effects.length === 0) return;
    effectChain = effectChain.then(async () => {
      try {
        for (const effect of step.effects) await perform(effect);
      } catch (err) {
        // The session is still taken (the phone call is live): stay held, and
        // let the next `ended` or return to the app try again.
        if (machine === 'idle') return;
        machine = 'held';
        held = true;
        emitEvent({
          type: 'error',
          code: 'resume_failed',
          message: err instanceof Error ? err.message : 'Could not resume the call audio.',
        });
      }
    });
  };

  const capture: EngineCapture = {
    async start(): Promise<void> {
      if (!(await backend.requestMicPermission())) throw new MicPermissionError();
      backend.configureSession();
      await backend.setSessionActive(true);
      resampler = null;
      framer.reset();
      feed({ type: 'call-start' });
      unsubs = [
        backend.onInterruption((notice) =>
          feed(
            notice.type === 'began'
              ? { type: 'began' }
              : { type: 'ended', shouldResume: notice.shouldResume },
          ),
        ),
        backend.onRouteChange((reason) => emitEvent({ type: 'route', reason })),
        ...(opts.appState ? [opts.appState.onActive(() => feed({ type: 'app-active' }))] : []),
      ];
      await startRecorder();
    },

    async stop(): Promise<void> {
      feed({ type: 'call-end' });
      for (const unsub of unsubs) unsub();
      unsubs = [];
      await effectChain.catch(() => {});
      held = false;
      level = 0;
      playout.stop();
      await backend.stopRecorder().catch(() => {});
      await backend.setSessionActive(false).catch(() => {});
      await backend.close().catch(() => {});
    },

    micStream: () => null,

    micLevel: () => (uplinkOpen() ? level : 0),

    setMicEnabled(enabled: boolean): void {
      micEnabled = enabled;
      if (!enabled) {
        level = 0;
        framer.reset();
      }
    },

    // Continuous capture: the server (or the realtime provider) endpoints.
    setCaptureEnabled: () => {},
    setBargeInEnabled: () => {},

    playEarcon: () => backend.playEarcon(),

    on(listener) {
      captureListeners.add(listener);
      return () => {
        captureListeners.delete(listener);
      };
    },

    get sampleRate(): number {
      return sampleRate;
    },
  };

  return {
    capture,
    playout,
    onFrame(listener) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    on(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    get held() {
      return held;
    },
  };
}

/**
 * The context `AbsolutePlayout` schedules on, over the backend's. Two jobs:
 *
 * - PCM buffers are created at the OUTPUT rate and their samples resampled on
 *   the way in, because the native source node ignores `buffer.sampleRate`
 *   (see `resampleClip`). Decoded clips need nothing: `decodeAudioData`
 *   decodes at the context's rate already.
 * - A clip the decoder refuses is reported before the rejection travels on —
 *   the shared streaming client swallows it (`streaming-voice-call-client.ts`,
 *   "an undecodable clip loses its audio"), so this is the only place a lost
 *   reply can still be noticed.
 */
function adaptPlayoutContext(
  ctx: PlayoutContext,
  outputRate: number,
  onUndecodable: (mime: string, err: unknown) => void,
): PlayoutContext {
  const sourceRates = new WeakMap<PlayoutBuffer, number>();
  return {
    get currentTime(): number {
      return ctx.currentTime;
    },
    get destination(): unknown {
      return ctx.destination;
    },
    createBuffer(channels, frames, sampleRate) {
      if (sampleRate === outputRate) return ctx.createBuffer(channels, frames, sampleRate);
      const buffer = ctx.createBuffer(
        channels,
        resampledLength(frames, sampleRate, outputRate),
        outputRate,
      );
      sourceRates.set(buffer, sampleRate);
      return buffer;
    },
    createBufferSource: () => ctx.createBufferSource(),
    createAnalyser: () => ctx.createAnalyser(),
    async decodeAudioData(data) {
      // Sniffed first: the decoder may detach `data`.
      const mime = sniffAudioMime(new Uint8Array(data, 0, Math.min(12, data.byteLength)));
      try {
        return await ctx.decodeAudioData(data);
      } catch (err) {
        onUndecodable(mime, err);
        throw err;
      }
    },
    fillMono(buffer, samples) {
      const fromRate = sourceRates.get(buffer);
      ctx.fillMono(
        buffer,
        fromRate === undefined ? samples : resampleClip(samples, fromRate, outputRate),
      );
    },
  };
}

/** The container a clip's leading bytes announce, for the undecodable notice.
 *  The same signatures react-native-audio-api's `detectAudioFormat` reads
 *  (common/cpp/audioapi/core/utils/AudioDecoding.cpp). */
export function sniffAudioMime(head: Uint8Array): string {
  const ascii = (at: number, text: string): boolean =>
    [...text].every((ch, i) => head[at + i] === ch.charCodeAt(0));
  const b0 = head[0] ?? 0;
  const b1 = head[1] ?? 0;
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'fLaC')) return 'audio/flac';
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(0, 'ID3') || (b0 === 0xff && (b1 & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(4, 'ftyp')) return 'audio/mp4';
  return 'unrecognised audio';
}

/** Load the library and build a production engine. Lazy by construction. */
export async function loadVoiceEngine(sampleRate: number): Promise<VoiceEngine> {
  const [backend, { AppState }] = await Promise.all([loadAudioBackend(), import('react-native')]);
  return createVoiceEngine({
    backend,
    sampleRate,
    appState: {
      onActive(listener) {
        const sub = AppState.addEventListener('change', (next) => {
          if (next === 'active') listener();
        });
        return () => sub.remove();
      },
    },
  });
}

/** `AudioBackend` over `react-native-audio-api` 0.13.6. */
export async function loadAudioBackend(): Promise<AudioBackend> {
  const lib: typeof AudioApi = await import('react-native-audio-api');
  const { AudioContext, AudioManager, AudioRecorder } = lib;
  // Device rate. The graph does NOT convert a buffer declared at another rate
  // (see `resampleClip`), so playout resamples PCM to `ctx.sampleRate` itself;
  // `decodeAudioData` decodes straight to it, and the capture side converts
  // itself.
  const ctx = new AudioContext();
  const recorder = new AudioRecorder();

  return {
    configureSession() {
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'voiceChat',
        iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP'],
      });
      AudioManager.observeAudioInterruptions(true);
    },

    setSessionActive: (active) => AudioManager.setAudioSessionActivity(active),

    async requestMicPermission() {
      return (await AudioManager.requestRecordingPermissions()) === 'Granted';
    },

    async startRecorder(preferred, onChunk) {
      const ready = recorder.onAudioReady(
        {
          sampleRate: preferred.sampleRate,
          bufferLength: preferred.bufferLength,
          channelCount: 1,
        },
        (event) => {
          onChunk({
            samples: event.buffer.getChannelData(0),
            sampleRate: event.buffer.sampleRate,
          });
        },
      );
      if (ready.status === 'error') throw new Error(ready.message);
      const started = await recorder.start();
      if (started.status === 'error') throw new Error(started.message);
    },

    async stopRecorder() {
      recorder.clearOnAudioReady();
      if (recorder.isRecording()) await recorder.stop();
    },

    playoutContext: playoutContextFrom(ctx),
    outputSampleRate: ctx.sampleRate,

    playEarcon() {
      // The web's "got it" blip (apps/web/src/features/voice/earcon.ts), kept
      // quiet so it cannot trip barge-in against itself.
      try {
        const NOTE_S = 0.12;
        const PEAK = 0.15;
        [880, 1175].forEach((freq, i) => {
          const startAt = ctx.currentTime + i * NOTE_S;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, startAt);
          gain.gain.linearRampToValueAtTime(PEAK, startAt + 0.01);
          gain.gain.linearRampToValueAtTime(0, startAt + NOTE_S);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(startAt);
          osc.stop(startAt + NOTE_S);
        });
      } catch {
        // Best-effort acknowledgement.
      }
    },

    onInterruption(listener) {
      const sub = AudioManager.addSystemEventListener('interruption', (event) =>
        listener({ type: event.type, shouldResume: event.shouldResume }),
      );
      return () => sub.remove();
    },

    onRouteChange(listener) {
      const sub = AudioManager.addSystemEventListener('routeChange', (event) =>
        listener(event.reason),
      );
      return () => sub.remove();
    },

    close: () => ctx.close(),
  };
}

/** Adapt the library's `AudioContext` to the scheduler's narrow surface. The
 *  one real difference from the web: a source node's end callback is
 *  `onEnded`, not `onended`. */
function playoutContextFrom(ctx: AudioApi.AudioContext): PlayoutContext {
  return {
    get currentTime(): number {
      return ctx.currentTime;
    },
    get destination(): unknown {
      return ctx.destination;
    },
    createBuffer: (channels, frames, rate) => ctx.createBuffer(channels, frames, rate),
    createBufferSource: () => sourceFrom(ctx.createBufferSource()),
    createAnalyser: (): PlayoutAnalyser => {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      return analyser;
    },
    decodeAudioData: (data) => ctx.decodeAudioData(data),
    fillMono: (buffer, samples) => {
      (buffer as AudioApi.AudioBuffer).copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    },
  };
}

function sourceFrom(node: AudioApi.AudioBufferSourceNode): PlayoutSource {
  let ended: (() => void) | null = null;
  return {
    get buffer(): PlayoutBuffer | null {
      return node.buffer;
    },
    set buffer(buffer: PlayoutBuffer | null) {
      node.buffer = buffer as AudioApi.AudioBuffer | null;
    },
    connect: (destination) => {
      node.connect(destination as AudioApi.AudioNode);
    },
    start: (when) => node.start(when),
    stop: (when) => node.stop(when ?? 0),
    get onended() {
      return ended;
    },
    set onended(callback: (() => void) | null) {
      ended = callback;
      node.onEnded = callback ? () => callback() : null;
    },
  };
}
