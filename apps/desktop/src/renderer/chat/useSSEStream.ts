import { EventStream, type EventStreamSubscription } from '@ethosagent/sdk';
import type { SseEvent } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

interface UseSSEStreamOptions {
  baseUrl: string;
  sessionId: string | null;
  onEvent: (event: SseEvent) => void;
  onError?: (err: unknown) => void;
}

interface UseSSEStreamResult {
  connected: boolean;
  reconnecting: boolean;
  close: () => void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export function useSSEStream(opts: UseSSEStreamOptions): UseSSEStreamResult {
  const { baseUrl, sessionId, onEvent, onError } = opts;
  const subRef = useRef<EventStreamSubscription | null>(null);
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // Stable refs for callbacks to avoid re-triggering the effect
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const close = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (subRef.current) {
      subRef.current.close();
      subRef.current = null;
    }
    setConnected(false);
    setReconnecting(false);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      close();
      return;
    }

    function connect() {
      // Capture last seq before closing
      const sinceSeq = subRef.current?.lastSeq;

      // Clean up any previous subscription
      if (subRef.current) {
        subRef.current.close();
        subRef.current = null;
      }

      const sub = EventStream({
        baseUrl,
        sessionId: sessionId as string,
        sinceSeq,
        onEvent: (event) => {
          setConnected(true);
          setReconnecting(false);
          backoffRef.current = MIN_BACKOFF_MS;
          onEventRef.current(event);
        },
        onError: (err) => {
          setConnected(false);
          onErrorRef.current?.(err);
          scheduleReconnect();
        },
      });

      subRef.current = sub;
    }

    function scheduleReconnect() {
      if (reconnectTimerRef.current) return;
      setReconnecting(true);

      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    function handleOnline() {
      if (subRef.current?.closed) {
        backoffRef.current = MIN_BACKOFF_MS;
        connect();
      }
    }

    window.addEventListener('online', handleOnline);
    connect();

    return () => {
      window.removeEventListener('online', handleOnline);
      close();
    };
  }, [baseUrl, sessionId, close]);

  return { connected, reconnecting, close };
}
