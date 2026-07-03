import { message } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { rpc } from '../../rpc';

type PlayState = 'idle' | 'loading' | 'playing';

interface PlayButtonProps {
  text: string;
}

export function PlayButton({ text }: PlayButtonProps) {
  const [state, setState] = useState<PlayState>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const cachedTextRef = useRef<string | null>(null);

  const handleClick = useCallback(async () => {
    if (state === 'playing') {
      audioRef.current?.pause();
      setState('idle');
      return;
    }

    if (state === 'loading') return;

    // Reuse cached audio if text hasn't changed
    if (blobUrlRef.current && cachedTextRef.current === text) {
      const audio = new Audio(blobUrlRef.current);
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('idle');
      setState('playing');
      await audio.play().catch(() => setState('idle'));
      return;
    }

    setState('loading');
    try {
      const result = await rpc.voice.synthesize({ text });
      const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mimeType });
      const url = URL.createObjectURL(blob);

      // Clean up previous blob URL
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = url;
      cachedTextRef.current = text;

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('idle');
      setState('playing');
      await audio.play().catch(() => setState('idle'));
    } catch (err) {
      setState('idle');
      const raw = err instanceof Error ? err.message : 'Text-to-speech failed';
      const msg = raw.includes('No TTS provider')
        ? 'TTS not configured — enable a TTS provider in Settings → Voice'
        : raw;
      void message.error(msg);
    }
  }, [state, text]);

  return (
    <button
      type="button"
      className={`play-btn${state === 'playing' ? ' play-btn-active' : ''}`}
      onClick={handleClick}
      aria-label={state === 'playing' ? 'Stop playback' : 'Read aloud'}
      title={state === 'playing' ? 'Stop' : 'Read aloud'}
    >
      {state === 'loading' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="28"
            strokeDashoffset="8"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 8 8"
              to="360 8 8"
              dur="0.8s"
              repeatCount="indefinite"
            />
          </circle>
        </svg>
      ) : state === 'playing' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
          <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3 5.5h2l3-2.5v10l-3-2.5H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"
            fill="currentColor"
          />
          <path
            d="M11 5.5a3.5 3.5 0 0 1 0 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M12.5 3.5a6 6 0 0 1 0 9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
