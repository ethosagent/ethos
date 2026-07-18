import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createUnwiredVoiceCallClient, type VoiceCallClient } from './voice-call-client';
import {
  initialVoiceCallState,
  type VoiceCallStatus,
  type VoiceTranscriptLine,
  voiceCallReducer,
} from './voice-call-reducer';

// Drives a `VoiceCallClient` through the pure `voiceCallReducer` and owns the
// browser-only concerns the reducer deliberately excludes: the mic level meter
// (same AudioContext/analyser pattern as `useVoiceRecorder`) and mute state.
// The client is injected so the UI works against the fake in tests and the real
// `livekit-client` binding in production.

const METER_BARS = 32;

export interface UseVoiceCallOptions {
  /** Factory for the live-call client. Defaults to the unwired placeholder. */
  createClient?: () => VoiceCallClient;
}

export interface UseVoiceCall {
  status: VoiceCallStatus;
  transcript: VoiceTranscriptLine[];
  /** Rolling mic-level history (0..1) for the speaking indicator. */
  micLevels: number[];
  muted: boolean;
  error: string | null;
  start: () => void;
  hangUp: () => void;
  toggleMute: () => void;
}

const flatLevels = () => Array.from({ length: METER_BARS }, () => 0);

export function useVoiceCall(options: UseVoiceCallOptions = {}): UseVoiceCall {
  const createClient = options.createClient ?? createUnwiredVoiceCallClient;
  const [state, dispatch] = useReducer(voiceCallReducer, initialVoiceCallState);
  const [micLevels, setMicLevels] = useState<number[]>(flatLevels);
  const [muted, setMuted] = useState(false);

  const clientRef = useRef<VoiceCallClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const teardownMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setMicLevels(flatLevels());
  }, []);

  const teardown = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    if (client) void client.disconnect().catch(() => {});
    teardownMeter();
    setMuted(false);
  }, [teardownMeter]);

  useEffect(() => teardown, [teardown]);

  const startMeter = useCallback((stream: MediaStream) => {
    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    analyserRef.current = analyser;

    const tick = () => {
      const a = analyserRef.current;
      if (a) {
        const data = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] ?? 0;
        const avg = Math.min(1, sum / data.length / 160);
        setMicLevels((prev) => {
          const next = prev.slice(1);
          next.push(avg);
          return next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(() => {
    if (state.status !== 'idle' && state.status !== 'ended') return;
    dispatch({ type: 'start' });

    const client = createClient();
    clientRef.current = client;
    unsubscribeRef.current = client.on((event) => {
      dispatch({ type: 'client-event', event });
      if (event.type === 'disconnected') teardown();
    });

    client
      .connect()
      .then(() => {
        // A late resolve after the user already hung up must not revive the call.
        if (clientRef.current !== client) return;
        dispatch({ type: 'connected' });
        const stream = client.micStream();
        if (stream) startMeter(stream);
      })
      .catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : 'Could not start voice call';
        dispatch({ type: 'client-event', event: { type: 'error', error: messageText } });
        teardown();
        dispatch({ type: 'hang-up' });
      });
  }, [state.status, createClient, startMeter, teardown]);

  const hangUp = useCallback(() => {
    teardown();
    dispatch({ type: 'hang-up' });
  }, [teardown]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      clientRef.current?.setMuted(next);
      return next;
    });
  }, []);

  return {
    status: state.status,
    transcript: state.transcript,
    micLevels,
    muted,
    error: state.error,
    start,
    hangUp,
    toggleMute,
  };
}
