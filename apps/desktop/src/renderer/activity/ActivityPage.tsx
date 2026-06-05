import { createEthosClient, EventStream } from '@ethosagent/sdk';
import type { SseEvent } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CostSparkline } from '../lab/observability/CostSparkline';
import { ErrorLogTable } from '../lab/observability/ErrorLogTable';
import { MetricsRow } from '../lab/observability/MetricsRow';
import { ToolCallChart } from '../lab/observability/ToolCallChart';
import { useAppState } from '../state/AppContext';
import { EventBadge } from '../ui/EventBadge';
import { FilterChip } from '../ui/FilterChip';

// ─── Types ───

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
type TabId = 'stream' | 'metrics';

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string; color?: string }> = [
  { value: 'all', label: 'All' },
  { value: 'tools', label: 'Tools', color: 'var(--blue, var(--accent))' },
  { value: 'turns', label: 'Turns', color: 'var(--slate, var(--text-secondary))' },
  { value: 'errors', label: 'Errors', color: 'var(--red, var(--error))' },
  { value: 'approvals', label: 'Approvals', color: 'var(--amber, var(--warning))' },
  { value: 'cron', label: 'Cron', color: 'var(--purple, #e879f9)' },
];

const MAX_EVENTS = 500;

// ─── Helpers ───

function eventMatchesFilter(evt: ActivityEvent, filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'tools') return evt.type === 'tool_start' || evt.type === 'tool_end';
  if (filter === 'turns') return evt.type === 'done';
  if (filter === 'errors') return evt.type === 'error';
  if (filter === 'approvals') return evt.type === 'tool.approval_required';
  if (filter === 'cron') return evt.type === 'cron.fired';
  return false;
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

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Event detail ───

type EventRow =
  | { key: string; kind: 'text'; value: string }
  | { key: string; kind: 'args'; args: unknown }
  | { key: string; kind: 'pre'; text: string };

function TruncatedPre({ text, maxLen = 400 }: { text: string; maxLen?: number }) {
  const truncated = text.length > maxLen;
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      {truncated ? `${text.slice(0, maxLen)}…` : text}
    </pre>
  );
}

function ArgsBlock({ args }: { args: unknown }) {
  if (typeof args !== 'object' || args === null) {
    return <TruncatedPre text={String(args)} />;
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0)
    return <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>—</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              minWidth: 60,
              flexShrink: 0,
            }}
          >
            {k}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, minWidth: 0 }}>
            {typeof v === 'object' ? (
              <pre
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {JSON.stringify(v, null, 2)}
              </pre>
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
    <div
      style={{
        padding: '8px 12px 8px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }}
    >
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              minWidth: 60,
              flexShrink: 0,
            }}
          >
            {row.key}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, minWidth: 0 }}>
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

// ─── Session & metrics types ───

interface SessionListItem {
  id: string;
  title: string | null;
}

interface Metrics {
  toolCalls: number;
  tokensUsed: number;
  estCost: number;
  errorRate: number;
}

interface ToolCallData {
  name: string;
  count: number;
}

interface CostDataPoint {
  date: string;
  cost: number;
}

interface ErrorEntry {
  timestamp: string;
  personality: string;
  tool: string;
  error: string;
}

// ─── Main page ───

export function ActivityPage() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('stream');

  // Auto-scroll state
  const streamRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newEventCount, setNewEventCount] = useState(0);

  // Metrics state (stub data until RPC exists)
  const [metrics] = useState<Metrics>({ toolCalls: 0, tokensUsed: 0, estCost: 0, errorRate: 0 });
  const [toolCalls] = useState<ToolCallData[]>([]);
  const [costHistory] = useState<CostDataPoint[]>([]);
  const [errors] = useState<ErrorEntry[]>([]);

  const activeSessionId = sessionFilter ?? sessions[0]?.id ?? null;

  // Load session list
  useEffect(() => {
    let cancelled = false;
    setSessionsLoading(true);
    client.rpc.sessions
      .list({ limit: 10 })
      .then((res) => {
        if (!cancelled) {
          setSessions(
            res.items.map((s: { id: string; title: string | null }) => ({
              id: s.id,
              title: s.title,
            })),
          );
          setSessionsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const appendEvent = useCallback(
    (evt: ActivityEvent) => {
      setEvents((prev) => [...prev, evt].slice(-MAX_EVENTS));
      if (!autoScroll) {
        setNewEventCount((c) => c + 1);
      }
    },
    [autoScroll],
  );

  // Subscribe to SSE
  useEffect(() => {
    if (!activeSessionId) return;
    const title = sessions.find((s) => s.id === activeSessionId)?.title ?? null;
    const sub = EventStream({
      baseUrl: `http://localhost:${port}`,
      sessionId: activeSessionId,
      onEvent: (sseEvent) => {
        const converted = convertSseEvent(sseEvent, activeSessionId, title);
        if (converted) appendEvent(converted);
      },
      onError: () => {},
    });
    return () => sub.close();
  }, [activeSessionId, port, sessions, appendEvent]);

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

  if (sessionsLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-display)',
          fontSize: 13,
        }}
      >
        Loading…
      </div>
    );
  }

  const tabStyle = (tab: TabId): React.CSSProperties => ({
    padding: '4px 12px',
    fontSize: 12,
    fontFamily: 'var(--font-display)',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderBottom: activeTab === tab ? '2px solid var(--text-primary)' : '2px solid transparent',
    color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
    transition: 'color 80ms ease',
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        fontFamily: 'var(--font-display)',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
          Observability
        </span>
        <select
          value={sessionFilter ?? ''}
          onChange={(e) => setSessionFilter(e.target.value || null)}
          style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            padding: '3px 8px',
            cursor: 'pointer',
            outline: 'none',
            minWidth: 160,
          }}
        >
          <option value="">All sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ?? s.id.slice(0, 12)}
            </option>
          ))}
        </select>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <button type="button" style={tabStyle('stream')} onClick={() => setActiveTab('stream')}>
          Events
        </button>
        <button type="button" style={tabStyle('metrics')} onClick={() => setActiveTab('metrics')}>
          Metrics
        </button>
      </div>

      {activeTab === 'stream' ? (
        <>
          {/* Filter chips */}
          <div
            style={{
              display: 'flex',
              gap: 6,
              padding: '8px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              flexShrink: 0,
            }}
          >
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
          <div ref={streamRef} style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
            {filtered.length === 0 ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '48px 0',
                  color: 'var(--text-tertiary)',
                  fontSize: 13,
                }}
              >
                No activity yet. Events will appear as sessions stream.
              </div>
            ) : (
              filtered.map((evt) => {
                const expanded = expandedEventId === evt.id;
                return (
                  <div key={evt.id}>
                    <button
                      type="button"
                      onClick={() => setExpandedEventId(expanded ? null : evt.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                        width: '100%',
                        padding: '0 4px',
                        lineHeight: '2',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        background: expanded ? 'var(--bg-elevated)' : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'inherit',
                      }}
                    >
                      <span
                        style={{
                          minWidth: 70,
                          flexShrink: 0,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--text-tertiary)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {formatTime(evt.timestamp)}
                      </span>
                      <EventBadge eventType={evt.type} />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {evt.summary}
                      </span>
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
            <button
              type="button"
              onClick={scrollToBottom}
              style={{
                position: 'absolute',
                bottom: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '4px 14px',
                borderRadius: 9999,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-elevated)',
                color: 'var(--blue, var(--accent))',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                zIndex: 10,
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}
            >
              ↓ {newEventCount} new event{newEventCount !== 1 ? 's' : ''}
            </button>
          )}
        </>
      ) : (
        /* Metrics tab */
        <div
          style={{
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            overflowY: 'auto',
            flex: 1,
          }}
        >
          <MetricsRow metrics={metrics} />
          <ToolCallChart data={toolCalls} />
          <CostSparkline data={costHistory} />
          <ErrorLogTable errors={errors} />
        </div>
      )}
    </div>
  );
}
