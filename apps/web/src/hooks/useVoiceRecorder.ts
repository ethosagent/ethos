import { useCallback, useEffect, useRef, useState } from 'react';

export interface VoiceRecorderState {
  isRecording: boolean;
  elapsedMs: number;
  error: string | null;
  audioLevels: number[];
}

export interface VoiceRecorderActions {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  cancelRecording: () => void;
}

const MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const MAX_DURATION_MS = 120_000;
const MIN_DURATION_MS = 500;

export function useVoiceRecorder(): VoiceRecorderState & VoiceRecorderActions {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioLevels, setAudioLevels] = useState<number[]>(() =>
    Array.from({ length: 32 }, () => 0),
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const resolveRef = useRef<((blob: Blob | null) => void) | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setAudioLevels(Array.from({ length: 32 }, () => 0));
    setIsRecording(false);
    setElapsedMs(0);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mimeType = MIME_PREFERENCE.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const elapsed = Date.now() - startTimeRef.current;
        if (elapsed < MIN_DURATION_MS) {
          resolveRef.current?.(null);
        } else {
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          });
          resolveRef.current?.(blob);
        }
        resolveRef.current = null;
      };

      startTimeRef.current = Date.now();
      recorder.start(250);
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        const now = Date.now();
        const elapsed = now - startTimeRef.current;
        setElapsedMs(elapsed);
        const a = analyserRef.current;
        if (a) {
          const data = new Uint8Array(a.frequencyBinCount);
          a.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = Math.min(1, sum / data.length / 160);
          setAudioLevels((prev) => {
            const next = prev.slice(1);
            next.push(avg);
            return next;
          });
        }
        if (elapsed >= MAX_DURATION_MS) {
          recorder.stop();
        }
      }, 100);
    } catch {
      setError('Microphone access required for voice input');
      cleanup();
    }
  }, [cleanup]);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state !== 'recording') {
        cleanup();
        resolve(null);
        return;
      }
      resolveRef.current = (blob) => {
        cleanup();
        resolve(blob);
      };
      recorder.stop();
    });
  }, [cleanup]);

  const cancelRecording = useCallback(() => {
    resolveRef.current = null;
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    cleanup();
  }, [cleanup]);

  return {
    isRecording,
    elapsedMs,
    error,
    audioLevels,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
