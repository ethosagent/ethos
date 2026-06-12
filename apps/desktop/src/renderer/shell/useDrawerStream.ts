import { EventStream, type EventStreamSubscription } from '@ethosagent/sdk';
import type { SseEvent } from '@ethosagent/web-contracts';
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppContext';

export interface ToolStreamEntry {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
}

export interface DrawerNotification {
  id: string;
  kind: 'cron.fired' | 'mesh.changed' | 'evolve.skill_pending';
  receivedAt: number;
  summary: string;
  deepLink: string;
}

export interface DrawerUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface DrawerState {
  sessionId: string | null;
  toolStream: ToolStreamEntry[];
  notifications: DrawerNotification[];
  usage: DrawerUsage | null;
}

const TOOL_STREAM_CAP = 50;
const NOTIFICATIONS_CAP = 25;

function emptyState(sessionId: string | null): DrawerState {
  return { sessionId, toolStream: [], notifications: [], usage: null };
}

function applyEvent(prev: DrawerState, event: SseEvent): DrawerState {
  const now = Date.now();
  switch (event.type) {
    case 'tool_start': {
      const entry: ToolStreamEntry = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        startedAt: now,
        status: 'running',
      };
      return {
        ...prev,
        toolStream: [entry, ...prev.toolStream].slice(0, TOOL_STREAM_CAP),
      };
    }
    case 'tool_end': {
      return {
        ...prev,
        toolStream: prev.toolStream.map((e) =>
          e.toolCallId === event.toolCallId
            ? {
                ...e,
                status: event.ok ? ('ok' as const) : ('error' as const),
                durationMs: event.durationMs,
              }
            : e,
        ),
      };
    }
    case 'usage': {
      return {
        ...prev,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        },
      };
    }
    case 'cron.fired': {
      return pushNotification(prev, {
        id: `cron:${event.jobId}:${event.ranAt}`,
        kind: 'cron.fired',
        receivedAt: now,
        summary: `Cron ${event.jobId} fired`,
        deepLink: 'cron',
      });
    }
    case 'mesh.changed': {
      return pushNotification(prev, {
        id: `mesh:${Math.floor(now / 1000)}`,
        kind: 'mesh.changed',
        receivedAt: now,
        summary: `Mesh updated (${event.agents.length} active)`,
        deepLink: 'mesh',
      });
    }
    case 'evolve.skill_pending': {
      return pushNotification(prev, {
        id: `skill:${event.skillId}:${event.proposedAt}`,
        kind: 'evolve.skill_pending',
        receivedAt: now,
        summary: `Skill ${event.skillId} pending review`,
        deepLink: 'skills',
      });
    }
    default:
      return prev;
  }
}

function pushNotification(prev: DrawerState, n: DrawerNotification): DrawerState {
  if (prev.notifications.some((x) => x.id === n.id)) return prev;
  return {
    ...prev,
    notifications: [n, ...prev.notifications].slice(0, NOTIFICATIONS_CAP),
  };
}

// Takes baseUrl as a parameter (rather than useServerUrl()) because AppShell
// calls this hook above the ServerUrlContext provider it renders.
export function useDrawerStream(baseUrl: string): DrawerState {
  const { state } = useAppState();
  const { activeSessionId } = state;

  const [drawerState, setDrawerState] = useState<DrawerState>(() => emptyState(activeSessionId));

  // Reset when session changes
  useEffect(() => {
    setDrawerState(emptyState(activeSessionId));
  }, [activeSessionId]);

  const subRef = useRef<EventStreamSubscription | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(1000);

  useEffect(() => {
    if (!activeSessionId) {
      if (subRef.current) {
        subRef.current.close();
        subRef.current = null;
      }
      return;
    }

    function connect() {
      const sinceSeq = subRef.current?.lastSeq;
      if (subRef.current) {
        subRef.current.close();
        subRef.current = null;
      }

      subRef.current = EventStream({
        baseUrl,
        sessionId: activeSessionId as string,
        sinceSeq,
        onEvent: (event) => {
          backoffRef.current = 1000;
          setDrawerState((prev) => applyEvent(prev, event));
        },
        onError: () => {
          scheduleReconnect();
        },
      });
    }

    function scheduleReconnect() {
      if (reconnectTimerRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, 30000);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (subRef.current) {
        subRef.current.close();
        subRef.current = null;
      }
    };
  }, [activeSessionId, baseUrl]);

  return drawerState;
}
