import type { SseEvent } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Empty, Select, Spin } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EventBadge } from '../components/ui/EventBadge';
import { FilterChip } from '../components/ui/FilterChip';
import { rpc } from '../rpc';
import { subscribeToSession } from '../sse';

interface ActivityEvent {
  id: string;
  timestamp: number;
  sessionId: string;
  sessionTitle: string | null;
  type: 'tool_start' | 'tool_end' | 'done' | 'error' | 'cron.fired' | 'tool.approval_required';
  summary: string;
  raw: unknown;
}

type TypeFilter = 'all' | 'tools' | 'turns' | 'errors' | 'approvals' | 'cron';

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string; color?: string }> = [
  { value: 'all', label: 'All' },
  { value: 'tools', label: 'Tools', color: 'var(--blue)' },
  { value: 'turns', label: 'Turns', color: 'var(--slate)' },
  { value: 'errors', label: 'Errors', color: 'var(--red)' },
  { value: 'approvals', label: 'Approvals', color: 'var(--amber)' },
  { value: 'cron', label: 'Cron', color: 'var(--purple)' },
];

function eventMatchesFilter(evt: ActivityEvent, filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'tools') return evt.type === 'tool_start' || evt.type === 'tool_end';
  if (filter === 'turns') return evt.type === 'done';
  if (filter === 'errors') return evt.type === 'error';
  if (filter === 'approvals') return evt.type === 'tool.approval_required';
  if (filter === 'cron') return evt.type === 'cron.fired';
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
        summary: `${event.toolName}(${formatArgs(event)})`,
      };
    case 'tool_end':
      return {
        ...base,
        id: `${sessionId}-${event.toolCallId}-end`,
        type: 'tool_end',
        summary: `${event.toolName} → ${event.ok ? 'ok' : 'error'}`,
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
        summary: String(event.error),
      };
    case 'tool.approval_required':
      return {
        ...base,
        id: `${sessionId}-approval-${event.request.approvalId}`,
        type: 'tool.approval_required',
        summary: `[waiting] ${event.request.toolName}`,
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

function formatArgs(event: { toolName: string; args?: unknown }): string {
  const args = event.args;
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    const truncated = val && val.length > 30 ? `${val.slice(0, 30)}…` : val;
    return `${k}: ${truncated}`;
  });
  const joined = parts.join(', ');
  return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const MAX_EVENTS = 500;

// ─── Event detail expansion ───

type EventRow =
  | { key: string; kind: 'text'; value: string }
  | { key: string; kind: 'args'; args: unknown }
  | { key: string; kind: 'pre'; text: string };

function TruncatedPre({ text, maxLen = 400 }: { text: string; maxLen?: number }) {
  const truncated = text.length > maxLen;
  return <pre className="aed-pre">{truncated ? `${text.slice(0, maxLen)}…` : text}</pre>;
}

function ArgsBlock({ args }: { args: unknown }) {
  if (typeof args !== 'object' || args === null) {
    return <TruncatedPre text={String(args)} />;
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return <span className="aed-empty">—</span>;
  return (
    <div className="aed-nested">
      {entries.map(([k, v]) => (
        <div key={k} className="aed-row">
          <span className="aed-key">{k}</span>
          <span className="aed-val">
            {typeof v === 'object' ? (
              <pre className="aed-pre">{JSON.stringify(v, null, 2)}</pre>
            ) : (
              <TruncatedPre text={String(v)} />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function EventDetail({ event }: { event: ActivityEvent }) {
  const raw = event.raw as Record<string, unknown>;
  const rows: EventRow[] = [];

  switch (event.type) {
    case 'tool_start':
      rows.push({ key: 'tool', kind: 'text', value: String(raw.toolName ?? '') });
      if (raw.args) rows.push({ key: 'args', kind: 'args', args: raw.args });
      break;
    case 'tool_end':
      rows.push({ key: 'tool', kind: 'text', value: String(raw.toolName ?? '') });
      rows.push({ key: 'status', kind: 'text', value: String(raw.ok ? 'ok' : 'failed') });
      rows.push({ key: 'duration', kind: 'text', value: `${String(raw.durationMs ?? 0)}ms` });
      if (raw.result) rows.push({ key: 'result', kind: 'pre', text: String(raw.result) });
      break;
    case 'done':
      if (raw.turnCount != null)
        rows.push({ key: 'turns', kind: 'text', value: String(raw.turnCount) });
      break;
    case 'error':
      rows.push({ key: 'error', kind: 'text', value: String(raw.error ?? '') });
      if (raw.code) rows.push({ key: 'code', kind: 'text', value: String(raw.code) });
      break;
    case 'tool.approval_required': {
      const req = (raw.request ?? {}) as Record<string, unknown>;
      rows.push({ key: 'tool', kind: 'text', value: String(req.toolName ?? '') });
      if (req.args) rows.push({ key: 'args', kind: 'args', args: req.args });
      break;
    }
    case 'cron.fired':
      rows.push({ key: 'job', kind: 'text', value: String(raw.jobId ?? '') });
      if (raw.ranAt) rows.push({ key: 'ran at', kind: 'text', value: String(raw.ranAt) });
      break;
  }

  if (rows.length === 0) return null;

  return (
    <div className="activity-event-detail">
      {rows.map((row) => (
        <div key={row.key} className="aed-row">
          <span className="aed-key">{row.key}</span>
          <span className="aed-val">
            {row.kind === 'args' ? (
              <ArgsBlock args={row.args} />
            ) : row.kind === 'pre' ? (
              <TruncatedPre text={row.text} />
            ) : (
              row.value
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main page ───

export function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Auto-scroll state
  const streamRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newEventCount, setNewEventCount] = useState(0);

  const { data: sessionsData, isLoading } = useQuery({
    queryKey: ['sessions', 'list', { limit: 10 }],
    queryFn: () => rpc.sessions.list({ limit: 10 }),
  });

  const sessions = sessionsData?.items ?? [];
  const activeSessionId = sessionFilter ?? sessions[0]?.id ?? null;

  const appendEvent = useCallback(
    (evt: ActivityEvent) => {
      setEvents((prev) => [...prev, evt].slice(-MAX_EVENTS));
      if (!autoScroll) {
        setNewEventCount((c) => c + 1);
      }
    },
    [autoScroll],
  );

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

  // Auto-scroll via IntersectionObserver
  useEffect(() => {
    const bottom = bottomRef.current;
    if (!bottom) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setAutoScroll(true);
          setNewEventCount(0);
        } else {
          setAutoScroll(false);
        }
      },
      { root: streamRef.current, threshold: 0.1 },
    );

    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);

  // Scroll to bottom when autoScroll is true and events change
  const eventCount = events.length;
  useEffect(() => {
    if (autoScroll && eventCount > 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [eventCount, autoScroll]);

  const filtered = useMemo(() => {
    return events.filter((evt) => {
      if (!eventMatchesFilter(evt, typeFilter)) return false;
      if (sessionFilter && evt.sessionId !== sessionFilter) return false;
      return true;
    });
  }, [events, typeFilter, sessionFilter]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setAutoScroll(true);
    setNewEventCount(0);
  };

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="obs-page">
      {/* Header */}
      <header className="obs-header">
        <h1 className="obs-title">Observability</h1>
        <Select
          allowClear
          placeholder="All sessions"
          size="small"
          style={{ width: 160 }}
          value={sessionFilter}
          onChange={(v) => setSessionFilter(v ?? null)}
          options={sessions.map((s) => ({
            value: s.id,
            label: s.title || s.id.slice(0, 12),
          }))}
        />
      </header>

      {/* Filter chips */}
      <div className="obs-chip-bar">
        {TYPE_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            label={f.label}
            active={typeFilter === f.value}
            color={f.color}
            onClick={() => setTypeFilter(f.value)}
          />
        ))}
      </div>

      {/* Event stream */}
      <div className="obs-stream" ref={streamRef}>
        {filtered.length === 0 ? (
          <Empty description="No activity yet. Events will appear as sessions stream." />
        ) : (
          filtered.map((evt) => {
            const expanded = expandedEventId === evt.id;
            return (
              <div key={evt.id}>
                <button
                  type="button"
                  className={`obs-event-line${expanded ? ' obs-event-line--expanded' : ''}`}
                  onClick={() => setExpandedEventId(expanded ? null : evt.id)}
                >
                  <span className="obs-event-ts">{formatTime(evt.timestamp)}</span>
                  <EventBadge eventType={evt.type} />
                  <span className="obs-event-content">{evt.summary}</span>
                </button>
                {expanded && <EventDetail event={evt} />}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* New events indicator */}
      {newEventCount > 0 && (
        <button type="button" className="obs-new-events" onClick={scrollToBottom}>
          ↓ {newEventCount} new event{newEventCount !== 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}
