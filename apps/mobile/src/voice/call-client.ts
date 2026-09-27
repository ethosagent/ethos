import {
  type CallTrace,
  createCallTrace,
  createLocalBargeIn,
  createRealtimeVoiceCallClient,
  createStreamingVoiceCallClient,
  createVoiceSocketTransport,
  PcmEndpointer,
  type PlayoutSink,
  type RealtimeSessionTicket,
  type RealtimeTokenAnswer,
  type RealtimeVoiceCallDeps,
  realtimeDegradeNotice,
  shouldTryRealtime,
  type TalkModeEnvironment,
  TIER_DEGRADED_CODE,
  type VoiceCallClient,
  type VoiceCallEvent,
  type VoiceSocketTransportOptions,
  type VoiceTier,
  type VoiceTransport,
  voiceSocketUrl,
} from '@ethosagent/voice-client';
import type { VoiceServerFrame } from '@ethosagent/web-contracts';
import type { EngineEvent, VoiceEngine } from './engine';
import { PIPELINE_SAMPLE_RATE } from './pcm';

// The phone's talk-mode client — the React Native counterpart of the web's
// `createTalkModeClient` (apps/web/src/features/voice/talk-mode-client.ts).
//
// Same two tiers, same rule, same shared clients: `voice.realtimeToken` either
// mints a ticket (realtime) or says why not (pipeline, with the reason shown
// unless it was the configured answer). What differs is only the audio and the
// credential:
//
// - audio comes from `engine.ts` (react-native-audio-api), loaded when a call
//   starts, at the rate the tier needs — 16 kHz for the lane, the provider's
//   `inputSampleRate` for realtime;
// - the voice lane authenticates with `Authorization: Bearer <key>` on the
//   upgrade (S8, apps/web-api/src/voice/voice-upgrade-auth.ts), because the
//   phone has no cookie.
//
// Two things the web does not do live here too, because only the phone has to
// meet the phone bar (packages/voice-client/src/bar.ts): LOCAL barge-in —
// playout stops on a sustained onset without waiting for the server — and a
// call trace, recording everything `analyzeTrace` grades.

/** Everything the phone can do once the engine loads; there is no batch tier. */
const PHONE_ENVIRONMENT: TalkModeEnvironment = {
  hasWebSocket: true,
  hasAudioContext: true,
  hasMediaDevices: true,
  hasScriptProcessor: true,
};

/** `AbsolutePlayout`'s default lead — what an encoded clip's start is estimated with. */
const PLAYOUT_LEAD_S = 0.05;

export interface PhoneCallDeps {
  /** The connected server, as stored at Connect (`http(s)://host[:port]`). */
  serverUrl: string;
  /** The key the Keychain holds; must carry `voice:talk`. */
  apiKey: string;
  personalityId?: string;
  /** Chat session the call belongs to (telemetry, and the realtime lane key). */
  sessionId?: () => string | null;
  /** The user's private/offline choice: never mint a realtime token. */
  forcePipeline?: boolean;
  /** `rpc.voice.realtimeToken`. Absent → pipeline tier, silently. */
  mintRealtimeToken?: () => Promise<RealtimeTokenAnswer>;
  /** Builds the engine at the tier's rate. Production: `loadVoiceEngine`. */
  loadEngine: (sampleRate: number) => Promise<VoiceEngine>;
  /** Test seam; production is `createVoiceSocketTransport`. */
  createTransport?: (opts: VoiceSocketTransportOptions) => VoiceTransport;
  /** Provider socket for the realtime tier. Production: React Native's `WebSocket`. */
  realtimeSocketFactory?: RealtimeVoiceCallDeps['socketFactory'];
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Written into the trace header (device, build, network profile). */
  traceLabel?: string;
  /** Which tier ran, once known. */
  onTier?: (tier: VoiceTier, detail: { provider?: string; model?: string | null }) => void;
}

export interface PhoneCallClient extends VoiceCallClient<null> {
  micLevel(): number;
  /** This call's trace, once a tier was chosen. Survives `disconnect()`. */
  trace(): CallTrace | null;
  /** Session events from the engine: held / resumed / route / error. */
  onEngine(listener: (event: EngineEvent) => void): () => void;
  /** Each scheduled agent audio start, on the `now()` clock — the "ear" end
   *  of mouth-to-ear. */
  onPlayoutStart(listener: (atMs: number) => void): () => void;
}

/** `https://host` → `wss://host/voice/ws`; `http` → `ws`. The lane lives at
 *  the origin, whatever path the stored URL carries. Parsed by hand: Hermes'
 *  `URL` does not implement `protocol`/`host`. */
export function phoneVoiceSocketUrl(serverUrl: string): string {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(serverUrl.trim());
  if (!match?.[1] || !match[2]) throw new Error(`Not an http(s) server URL: ${serverUrl}`);
  return voiceSocketUrl({ protocol: `${match[1].toLowerCase()}:`, host: match[2] });
}

const monotonicNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export function createPhoneCallClient(deps: PhoneCallDeps): PhoneCallClient {
  const now = deps.now ?? monotonicNow;
  const createTransport = deps.createTransport ?? createVoiceSocketTransport;
  const listeners = new Set<(event: VoiceCallEvent) => void>();
  const engineListeners = new Set<(event: EngineEvent) => void>();
  const playoutListeners = new Set<(atMs: number) => void>();
  const emit = (event: VoiceCallEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  let inner: VoiceCallClient<null> | null = null;
  let engine: VoiceEngine | null = null;
  let trace: CallTrace | null = null;
  let muted = false;
  let cleanups: Array<() => void> = [];

  const laneTransport = (): VoiceTransport =>
    createTransport({
      url: phoneVoiceSocketUrl(deps.serverUrl),
      headers: { Authorization: `Bearer ${deps.apiKey}` },
    });

  /**
   * Wire one tier's engine + lane into the trace, local barge-in and the
   * listeners. Returns the playout the tier client must use (traced, and gated
   * after a local barge-in) and the lane (traced).
   */
  const instrument = (
    tier: VoiceTier,
    eng: VoiceEngine,
    lane: VoiceTransport,
  ): { playout: PlayoutSink; transport: VoiceTransport } => {
    const t = createCallTrace({
      tier,
      clock: { now, audioNow: () => eng.playout.now() },
      ...(deps.traceLabel !== undefined ? { label: deps.traceLabel } : {}),
    });
    trace = t;
    engine = eng;

    // Which reply is playing. The lane stamps its audio with an utteranceId;
    // the realtime tier's audio arrives on the provider socket with none, so
    // replies are counted instead.
    let laneUtterance: string | null = null;
    let replyCount = 0;
    const currentReply = (): string => laneUtterance ?? `reply-${replyCount}`;
    /** The reply the user talked over: its remaining audio is not played. */
    let bargedReply: string | null = null;
    let lastEnd = 0;
    let lastReply: string | null = null;
    let stopReason: string | null = null;

    const recordSchedule = (startAt: number, dur: number, reply: string): void => {
      if (lastReply === reply && lastEnd > 0 && startAt - lastEnd > 0.001) {
        t.underrun((startAt - lastEnd) * 1000);
      }
      lastEnd = startAt + dur;
      lastReply = reply;
      t.sched(startAt, dur, reply);
      const startMs = now() + (startAt - eng.playout.now()) * 1000;
      for (const listener of [...playoutListeners]) listener(startMs);
    };

    const playout: PlayoutSink = {
      playPcm16(samples, sampleRate) {
        const reply = currentReply();
        if (reply === bargedReply) return eng.playout.now();
        const end = eng.playout.playPcm16(samples, sampleRate);
        const dur = samples.length / sampleRate;
        if (dur > 0) recordSchedule(end - dur, dur, reply);
        return end;
      },
      async playEncoded(bytes) {
        const reply = currentReply();
        if (reply === bargedReply) return eng.playout.now();
        const before = lastEnd;
        const end = await eng.playout.playEncoded(bytes);
        // The decoded duration is not reported, so the start is where the
        // scheduler would have put it: after what was queued, or one lead
        // past now.
        const startAt = Math.max(before, eng.playout.now() + PLAYOUT_LEAD_S);
        if (end > startAt) recordSchedule(startAt, end - startAt, reply);
        return end;
      },
      now: () => eng.playout.now(),
      whenIdle: () => eng.playout.whenIdle(),
      stop() {
        t.stop(stopReason ?? 'client');
        stopReason = null;
        lastEnd = 0;
        eng.playout.stop();
      },
      get speaking() {
        return eng.playout.speaking;
      },
      outputLevel: () => eng.playout.outputLevel(),
    };

    const bargeIn = createLocalBargeIn({
      playout: {
        speaking: () => eng.playout.speaking,
        stop: () => {
          bargedReply = currentReply();
          stopReason = 'local_barge_in';
          playout.stop();
        },
      },
      now,
    });

    // Speech onset/end markers for the trace — the "mouth" end. The server
    // (or provider) endpoints the real turn; this only timestamps it locally.
    const markers = new PcmEndpointer(eng.capture.sampleRate);

    const transport: VoiceTransport = {
      connect: () => lane.connect(),
      send(frame, payload) {
        if (frame.t === 'audio') t.txAudio(frame.seq);
        lane.send(frame, payload);
      },
      on: (listener) => lane.on(listener),
      onStatus: (listener) => lane.onStatus(listener),
      get status() {
        return lane.status;
      },
      close: () => lane.close(),
    };

    cleanups = [
      // Registered before the tier client subscribes (inside its `connect`),
      // so the current utterance is known when its audio is scheduled.
      lane.on((frame) => {
        t.rx(frame.t, frameIds(frame));
        if (frame.t === 'audio') laneUtterance = frame.utteranceId;
      }),
      lane.onStatus((status) => t.link(status)),
      eng.onFrame((frame, rms) => {
        t.micFrame(rms, frame.length);
        for (const event of markers.push(frame)) {
          if (event.type === 'speech_start') t.localOnset();
          else if (event.type === 'speech_end') t.localEnd();
        }
        bargeIn.frame(rms);
      }),
      eng.on((event) => {
        if (event.type === 'held') t.interruption('began');
        if (event.type === 'resumed') t.interruption('ended');
        for (const listener of [...engineListeners]) listener(event);
      }),
    ];

    // A reply ending — either way — opens the next one for the realtime count
    // and lifts the barge-in gate.
    const onReplyEnd = (event: VoiceCallEvent): void => {
      if (event.type === 'reply_complete' || event.type === 'interrupted') {
        replyCount++;
        bargedReply = null;
        bargeIn.reset();
      }
    };
    listeners.add(onReplyEnd);
    cleanups.push(() => listeners.delete(onReplyEnd));

    return { playout, transport };
  };

  const adopt = (client: VoiceCallClient<null>): void => {
    inner = client;
    const unsub = client.on(emit);
    cleanups.push(unsub);
    if (muted) client.setMuted(true);
  };

  const release = async (): Promise<void> => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    const client = inner;
    inner = null;
    engine = null;
    await client?.disconnect().catch(() => {});
  };

  const tryRealtime = async (): Promise<boolean> => {
    if (!deps.mintRealtimeToken) return false;
    if (
      !shouldTryRealtime({ forcePipeline: deps.forcePipeline, canMint: true }, PHONE_ENVIRONMENT)
    ) {
      return false;
    }
    let answer: RealtimeTokenAnswer;
    try {
      answer = await deps.mintRealtimeToken();
    } catch {
      emit({
        type: 'error',
        error: 'Could not reach the realtime voice service; continuing on the local pipeline.',
        code: TIER_DEGRADED_CODE,
      });
      return false;
    }
    if (!answer.ok) {
      const notice = realtimeDegradeNotice(answer);
      if (notice) emit({ type: 'error', error: notice, code: TIER_DEGRADED_CODE });
      return false;
    }

    try {
      const eng = await deps.loadEngine(answer.inputSampleRate);
      const { playout, transport } = instrument('realtime', eng, laneTransport());
      const ticket: RealtimeSessionTicket = answer;
      adopt(
        createRealtimeVoiceCallClient<null>({
          session: ticket,
          capture: eng.capture,
          playout,
          control: transport,
          socketFactory: deps.realtimeSocketFactory ?? createNativeRealtimeSocket,
          mintTicket: async () => {
            const next = await deps.mintRealtimeToken?.();
            return next?.ok ? next : null;
          },
          ...(deps.sessionId ? { chatSessionId: deps.sessionId } : {}),
          ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
        }),
      );
      await inner?.connect();
    } catch (err) {
      await release();
      emit({
        type: 'error',
        error:
          err instanceof Error && err.message ? err.message : 'Realtime voice failed to start.',
        code: TIER_DEGRADED_CODE,
      });
      return false;
    }
    deps.onTier?.('realtime', { provider: answer.providerId, model: answer.model });
    return true;
  };

  return {
    async connect(): Promise<void> {
      if (await tryRealtime()) return;
      const eng = await deps.loadEngine(PIPELINE_SAMPLE_RATE);
      const { playout, transport } = instrument('pipeline', eng, laneTransport());
      adopt(
        createStreamingVoiceCallClient<null>({
          transport,
          capture: eng.capture,
          playout,
          ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
          ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
        }),
      );
      deps.onTier?.('pipeline', {});
      await inner?.connect();
    },

    disconnect: release,

    setMuted(next: boolean): void {
      muted = next;
      inner?.setMuted(next);
    },

    micStream: () => null,

    micLevel: () => engine?.capture.micLevel() ?? 0,

    outputLevel: () => inner?.outputLevel?.() ?? 0,

    trace: () => trace,

    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    onEngine(listener) {
      engineListeners.add(listener);
      return () => {
        engineListeners.delete(listener);
      };
    },

    onPlayoutStart(listener) {
      playoutListeners.add(listener);
      return () => {
        playoutListeners.delete(listener);
      };
    },
  };
}

function frameIds(frame: VoiceServerFrame): {
  utteranceId?: string;
  segmentId?: string;
  seq?: number;
} {
  const ids: { utteranceId?: string; segmentId?: string; seq?: number } = {};
  if ('utteranceId' in frame && typeof frame.utteranceId === 'string') {
    ids.utteranceId = frame.utteranceId;
  }
  if ('segmentId' in frame && typeof frame.segmentId === 'string') ids.segmentId = frame.segmentId;
  if ('seq' in frame && typeof frame.seq === 'number') ids.seq = frame.seq;
  return ids;
}

/** The slice of React Native's `WebSocket` the provider socket uses. RN takes
 *  subprotocols as the second argument and headers in a third. */
interface NativeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}
type NativeSocketCtor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers: Record<string, string> },
) => NativeSocket;

/** The realtime tier's provider socket over React Native's `WebSocket` — the
 *  phone's `createBrowserRealtimeSocket`. */
export const createNativeRealtimeSocket: RealtimeVoiceCallDeps['socketFactory'] = (
  init,
  handlers,
) => {
  const Ctor = globalThis.WebSocket as unknown as NativeSocketCtor;
  const socket = new Ctor(
    init.url,
    init.subprotocols?.length ? init.subprotocols : undefined,
    init.headers ? { headers: init.headers } : undefined,
  );
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  };
  socket.onerror = (event) => handlers.onError(event.message || 'realtime socket error');
  socket.onclose = (event) =>
    handlers.onClose(event.reason || `socket closed (code ${event.code ?? 0})`);
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code ?? 1000, reason),
  };
};
