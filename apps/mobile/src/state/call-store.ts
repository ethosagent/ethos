import {
  classifyVoiceStartError,
  initialVoiceCallState,
  isTerminalClientEvent,
  providerSummary,
  type VoiceCallAction,
  type VoiceCallState,
  type VoiceTier,
  voiceCallReducer,
} from '@ethosagent/voice-client';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createPhoneCallClient, type PhoneCallClient } from '../voice/call-client';
import { loadVoiceEngine } from '../voice/engine';
import { useConnection } from './connection';

// The live call, as the Call Stage reads it (T7). A zustand store over the
// shared `voiceCallReducer` — the same state machine the web's `useVoiceCall`
// drives — plus what the phone adds: the OS holding the session (`held`),
// push-to-talk, the turn's latency marks and the call trace.
//
// The client is built per call by `deps.createClient`, so the store tests
// against a fake and production builds the real one from the connected
// server and key (`createDefaultCallClient` below).

/**
 * Latency of the last spoken turn, in ms, measured on the phone from the
 * events the user experienced (the web's `useVoiceCall` marks, ~181-208).
 */
export interface CallTurnLatency {
  /** Utterance committed → first reply sentence: the model's thinking time. */
  llmMs: number | null;
  /** First reply sentence → first audio scheduled to play. */
  ttsMs: number | null;
  /** Utterance committed → first audio scheduled to play. */
  totalMs: number | null;
}

export interface CallStartOptions {
  personalityId?: string;
  /** Chat session the call belongs to. */
  sessionId?: string | null;
  /** The user's private/offline choice: never the realtime tier. */
  forcePipeline?: boolean;
}

export interface CallClientHooks {
  onTier(tier: VoiceTier, detail: { provider?: string; model?: string | null }): void;
}

export interface CallStoreDeps {
  createClient(options: CallStartOptions, hooks: CallClientHooks): PhoneCallClient;
  /** Monotonic ms — the same clock the client's trace uses. */
  now?: () => number;
}

export interface CallStore {
  /** The shared reducer's state: status, transcript, notices, tier, providers. */
  call: VoiceCallState;
  /** The mic is closed (mute, or push-to-talk between presses). */
  muted: boolean;
  /** Push-to-talk is in use: the mic stays closed between holds. */
  pushToTalk: boolean;
  /** The OS has the audio session (a phone call, Siri). Resumes by itself. */
  held: boolean;
  /** The realtime provider and model when that tier is serving. */
  realtime: { provider: string; model: string | null } | null;
  latency: CallTurnLatency;

  start(options?: CallStartOptions): void;
  end(): void;
  toggleMute(): void;
  /** Push-to-talk: open the mic while held. */
  holdToTalk(): void;
  /** Push-to-talk: close it again. */
  releaseToTalk(): void;
  dismissNotice(): void;

  /** `provider · model` for whichever engine is working right now. */
  providerLabel(): string;
  /** Smoothed mic level 0..1 — read per frame, not stored. */
  micLevel(): number;
  /** Smoothed agent output level 0..1 — read per frame, not stored. */
  agentLevel(): number;
  /** The current (or last) call's trace as JSONL, for "Share call trace". */
  traceJsonl(): string | null;
}

const NO_LATENCY: CallTurnLatency = { llmMs: null, ttsMs: null, totalMs: null };

const monotonicNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export function createCallStore(deps: CallStoreDeps): StoreApi<CallStore> {
  const now = deps.now ?? monotonicNow;
  let client: PhoneCallClient | null = null;
  /** Kept past hang-up so the trace can still be shared. */
  let lastClient: PhoneCallClient | null = null;
  let unsubs: Array<() => void> = [];
  /** The in-flight turn's marks. */
  let marks: { committedAt: number; sentenceAt: number | null; audioAt: number | null } | null =
    null;
  /** This call already told the user a clip could not be played. */
  let playbackNoticed = false;

  return createStore<CallStore>((set, get) => {
    const dispatch = (action: VoiceCallAction): void =>
      set((s) => ({ call: voiceCallReducer(s.call, action) }));

    const teardown = (): void => {
      for (const unsub of unsubs) unsub();
      unsubs = [];
      const current = client;
      client = null;
      if (current) void current.disconnect().catch(() => {});
      set({ muted: false, pushToTalk: false, held: false });
    };

    const markLatency = (type: string): void => {
      const at = now();
      if (type === 'utterance_committed') {
        marks = { committedAt: at, sentenceAt: null, audioAt: null };
        set({ latency: NO_LATENCY });
        return;
      }
      if (type === 'reply_sentence' && marks && marks.sentenceAt === null) {
        const committedAt = marks.committedAt;
        marks.sentenceAt = at;
        set((s) => ({ latency: { ...s.latency, llmMs: Math.round(at - committedAt) } }));
      }
    };

    /** The first audio of the turn, at the time it is scheduled to be heard. */
    const markFirstAudio = (atMs: number): void => {
      if (!marks || marks.audioAt !== null) return;
      marks.audioAt = atMs;
      const { committedAt, sentenceAt } = marks;
      set((s) => ({
        latency: {
          llmMs: s.latency.llmMs,
          ttsMs: sentenceAt === null ? null : Math.round(atMs - sentenceAt),
          totalMs: Math.round(atMs - committedAt),
        },
      }));
    };

    const setMuted = (muted: boolean): void => {
      client?.setMuted(muted);
      set({ muted });
    };

    return {
      call: initialVoiceCallState,
      muted: false,
      pushToTalk: false,
      held: false,
      realtime: null,
      latency: NO_LATENCY,

      start(options = {}) {
        const { status } = get().call;
        if (status !== 'idle' && status !== 'ended') return;
        dispatch({ type: 'start' });
        marks = null;
        playbackNoticed = false;
        set({ latency: NO_LATENCY, realtime: null, held: false, muted: false, pushToTalk: false });

        let next: PhoneCallClient;
        try {
          next = deps.createClient(options, {
            onTier(tier, detail) {
              if (client !== next) return;
              dispatch({ type: 'tier', tier });
              if (tier === 'realtime' && detail.provider) {
                set({ realtime: { provider: detail.provider, model: detail.model ?? null } });
              }
            },
          });
        } catch (err) {
          dispatch({ type: 'client-event', event: classifyVoiceStartError(err) });
          dispatch({ type: 'hang-up' });
          return;
        }
        client = next;
        lastClient = next;
        unsubs = [
          next.on((event) => {
            dispatch({ type: 'client-event', event });
            markLatency(event.type);
            // Every route to a terminal state releases the mic (the web's rule).
            if (isTerminalClientEvent(event)) teardown();
          }),
          next.onEngine((event) => {
            if (event.type === 'held') set({ held: true });
            if (event.type === 'resumed') set({ held: false });
            // Lost reply audio is never silent, and said once: the rest of the
            // call would only repeat it. The trace keeps every occurrence.
            if (event.type === 'error' && event.code === 'undecodable_audio' && !playbackNoticed) {
              playbackNoticed = true;
              set((s) => ({ call: { ...s.call, notice: event.message } }));
            }
          }),
          next.onPlayoutStart(markFirstAudio),
        ];

        next
          .connect()
          .then(() => {
            // A late resolve after a hang-up must not revive the call.
            if (client !== next) return;
            dispatch({ type: 'connected' });
          })
          .catch((err: unknown) => {
            if (client !== next) return;
            dispatch({ type: 'client-event', event: classifyVoiceStartError(err) });
            teardown();
            dispatch({ type: 'hang-up' });
          });
      },

      end() {
        teardown();
        dispatch({ type: 'hang-up' });
      },

      toggleMute() {
        setMuted(!get().muted);
      },

      holdToTalk() {
        set({ pushToTalk: true });
        setMuted(false);
      },

      releaseToTalk() {
        set({ pushToTalk: true });
        setMuted(true);
      },

      dismissNotice() {
        dispatch({ type: 'dismiss-notice' });
      },

      providerLabel() {
        const { call, realtime } = get();
        return providerSummary({
          status: call.status,
          sttProvider: call.sttProvider,
          ttsProvider: call.ttsProvider,
          realtimeProvider: realtime?.provider ?? null,
          realtimeModel: realtime?.model ?? null,
        });
      },

      micLevel: () => client?.micLevel() ?? 0,

      agentLevel: () => client?.outputLevel?.() ?? 0,

      traceJsonl: () => lastClient?.trace()?.toJsonl() ?? null,
    };
  });
}

/** Production client: the connected server and Keychain key, the RPC's
 *  realtime mint, and the native engine. */
export function createDefaultCallClient(
  options: CallStartOptions,
  hooks: CallClientHooks,
): PhoneCallClient {
  const { url, key, client } = useConnection.getState();
  if (!url || !key || !client) throw new Error('Not connected');
  const { personalityId, sessionId, forcePipeline } = options;
  return createPhoneCallClient({
    serverUrl: url,
    apiKey: key,
    loadEngine: loadVoiceEngine,
    mintRealtimeToken: () => client.rpc.voice.realtimeToken(personalityId ? { personalityId } : {}),
    onTier: hooks.onTier,
    ...(personalityId ? { personalityId } : {}),
    ...(sessionId ? { sessionId: () => sessionId } : {}),
    ...(forcePipeline ? { forcePipeline } : {}),
  });
}

/** The app's one call. */
export const callStore = createCallStore({ createClient: createDefaultCallClient });

export function useCallStore<T>(selector: (state: CallStore) => T): T {
  return useStore(callStore, selector);
}
