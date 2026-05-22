import type { SseEvent } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Empty, Select, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { rpc } from '../rpc';
import { subscribeToSession } from '../sse';

interface ActivityEvent {
  id: string;
  timestamp: number;
  sessionId: string;
  sessionTitle: string | null;
  type:
    | 'tool_start'
    | 'tool_end'
    | 'text_delta'
    | 'done'
    | 'error'
    | 'cron.fired'
    | 'tool.approval_required';
  summary: string;
  raw: unknown;
}

type TypeFilter = 'all' | 'tools' | 'turns' | 'errors' | 'approvals' | 'cron';

const MAX_EVENTS = 50;

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'tools', label: 'Tools' },
  { value: 'turns', label: 'Turns' },
  { value: 'errors', label: 'Errors' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'cron', label: 'Cron' },
];

const DOT_CLASS_MAP: Record<ActivityEvent['type'], string> = {
  tool_start: 'tool_start',
  tool_end: 'tool_end',
  text_delta: 'tool_start',
  done: 'done',
  error: 'error',
  'tool.approval_required': 'approval',
  'cron.fired': 'cron',
};

const TYPE_COLORS: Record<ActivityEvent['type'], string> = {
  tool_start: 'blue',
  tool_end: 'blue',
  text_delta: 'default',
  done: 'green',
  error: 'red',
  'tool.approval_required': 'orange',
  'cron.fired': 'purple',
};

function matchesTypeFilter(type: ActivityEvent['type'], filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'tools') return type === 'tool_start' || type === 'tool_end';
  if (filter === 'turns') return type === 'done';
  if (filter === 'errors') return type === 'error';
  if (filter === 'approvals') return type === 'tool.approval_required';
  if (filter === 'cron') return type === 'cron.fired';
  return false;
}

function convertSseEvent(
  event: SseEvent,
  sessionId: string,
  sessionTitle: string | null,
): ActivityEvent | null {
  const base = { sessionId, sessionTitle, timestamp: Date.now(), raw: event };

  switch (event.type) {
    case 'tool_start':
      return {
        ...base,
        id: `${sessionId}-${event.toolCallId}-start`,
        type: 'tool_start',
        summary: `Tool started: ${event.toolName}`,
      };
    case 'tool_end':
      return {
        ...base,
        id: `${sessionId}-${event.toolCallId}-end`,
        type: 'tool_end',
        summary: `Tool ${event.ok ? 'completed' : 'failed'}: ${event.toolName} (${event.durationMs}ms)`,
      };
    case 'done':
      return {
        ...base,
        id: `${sessionId}-done-${Date.now()}`,
        type: 'done',
        summary: `Turn ${event.turnCount} completed`,
      };
    case 'error':
      return {
        ...base,
        id: `${sessionId}-error-${Date.now()}`,
        type: 'error',
        summary: `Error: ${event.error}`,
      };
    case 'tool.approval_required':
      return {
        ...base,
        id: `${sessionId}-approval-${event.request.approvalId}`,
        type: 'tool.approval_required',
        summary: `Approval needed: ${event.request.toolName}`,
      };
    case 'cron.fired':
      return {
        ...base,
        id: `cron-${event.jobId}-${event.ranAt}`,
        type: 'cron.fired',
        summary: `Cron job fired: ${event.jobId}`,
      };
    default:
      return null;
  }
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: sessionsData, isLoading } = useQuery({
    queryKey: ['sessions', 'list', { limit: 10 }],
    queryFn: () => rpc.sessions.list({ limit: 10 }),
  });

  const sessions = sessionsData?.items ?? [];

  const appendEvent = useCallback((evt: ActivityEvent) => {
    setEvents((prev) => {
      const next = [evt, ...prev];
      if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
      return next;
    });
  }, []);

  const activeSessionId = sessionFilter ?? sessions[0]?.id ?? null;

  useEffect(() => {
    if (!activeSessionId) return;

    const activeSession = sessions.find((s) => s.id === activeSessionId);
    const title = activeSession?.title ?? null;

    const sub = subscribeToSession(activeSessionId, {
      onEvent: (sseEvent) => {
        const converted = convertSseEvent(sseEvent, activeSessionId, title);
        if (converted) appendEvent(converted);
      },
    });

    return () => sub.close();
  }, [activeSessionId, sessions, appendEvent]);

  const filtered = events.filter((evt) => {
    if (!matchesTypeFilter(evt.type, typeFilter)) return false;
    if (sessionFilter && evt.sessionId !== sessionFilter) return false;
    return true;
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="activity-page">
      <header className="activity-toolbar">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Activity
        </Typography.Title>
        <Select
          allowClear
          placeholder="Most recent session"
          size="small"
          style={{ width: 220 }}
          value={sessionFilter}
          onChange={(v) => setSessionFilter(v ?? null)}
          options={sessions.map((s) => ({
            value: s.id,
            label: s.title || s.id.slice(0, 12),
          }))}
        />
      </header>

      <div className="activity-filter-bar">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`activity-filter-chip${typeFilter === f.value ? ' active' : ''}`}
            onClick={() => setTypeFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="activity-timeline">
        {filtered.length === 0 ? (
          <Empty description="No activity yet. Events will appear as sessions stream." />
        ) : (
          filtered.map((evt) => {
            const expanded = expandedId === evt.id;
            return (
              <button
                key={evt.id}
                type="button"
                className={`activity-event${expanded ? ' activity-event--expanded' : ''}`}
                onClick={() => setExpandedId(expanded ? null : evt.id)}
              >
                <div className="activity-event-header">
                  <span
                    className={`activity-event-dot activity-event-dot--${DOT_CLASS_MAP[evt.type]}`}
                  />
                  <span className="activity-event-time">{formatRelative(evt.timestamp)}</span>
                  <Tag color={TYPE_COLORS[evt.type]}>{evt.type}</Tag>
                  <span className="activity-event-summary">{evt.summary}</span>
                </div>
                <div className="activity-event-session">
                  Session: {evt.sessionTitle || evt.sessionId.slice(0, 8)}
                </div>
                {expanded && (
                  <pre className="activity-event-raw">{JSON.stringify(evt.raw, null, 2)}</pre>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
