import { createEthosClient, EventStream } from '@ethosagent/sdk';
import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppContext';

interface ActivityEvent {
  id: string;
  timestamp: number;
  sessionId: string;
  sessionTitle: string | null;
  type: 'tool_start' | 'tool_end' | 'done' | 'error' | 'cron.fired' | 'tool.approval_required';
  summary: string;
  raw: unknown;
}

interface ConversationGroup {
  id: string;
  sessionId: string;
  sessionTitle: string | null;
  startedAt: number;
  completedAt: number | null;
  turnCount: number | null;
  events: ActivityEvent[];
  isLive: boolean;
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

const EVENT_TYPE_COLORS: Record<ActivityEvent['type'], string> = {
  tool_start: 'rgba(74,158,255,0.15)',
  tool_end: 'rgba(74,158,255,0.15)',
  done: 'rgba(40,200,100,0.15)',
  error: 'rgba(255,80,80,0.15)',
  'tool.approval_required': 'rgba(255,160,40,0.15)',
  'cron.fired': 'rgba(160,80,255,0.15)',
};

const EVENT_TYPE_TEXT_COLORS: Record<ActivityEvent['type'], string> = {
  tool_start: 'var(--accent)',
  tool_end: 'var(--accent)',
  done: 'var(--success)',
  error: 'var(--error)',
  'tool.approval_required': 'var(--warning)',
  'cron.fired': 'var(--purple)',
};

const EVENT_TYPE_DOT_COLORS: Record<ActivityEvent['type'], string> = {
  tool_start: 'var(--accent)',
  tool_end: 'var(--accent)',
  done: 'var(--success)',
  error: 'var(--error)',
  'tool.approval_required': 'var(--warning)',
  'cron.fired': 'var(--purple)',
};

function groupMatchesFilter(group: ConversationGroup, filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'tools')
    return group.events.some((e) => e.type === 'tool_start' || e.type === 'tool_end');
  if (filter === 'turns') return group.events.some((e) => e.type === 'done');
  if (filter === 'errors') return group.events.some((e) => e.type === 'error');
  if (filter === 'approvals') return group.events.some((e) => e.type === 'tool.approval_required');
  if (filter === 'cron') return group.events.some((e) => e.type === 'cron.fired');
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

type EventRow =
  | { key: string; kind: 'text'; value: string }
  | { key: string; kind: 'args'; args: unknown }
  | { key: string; kind: 'pre'; text: string };

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
      rows.push({ key: 'status', kind: 'text', value: String(raw.ok ? '✓ ok' : '✗ failed') });
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

interface SessionListItem {
  id: string;
  title: string | null;
}

interface SessionData {
  messages: StoredMessage[];
  session: { title: string | null };
}

export function ActivityPage() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [groups, setGroups] = useState<ConversationGroup[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);

  const activeSessionId = sessionFilter ?? sessions[0]?.id ?? null;

  const _completedGroupCount = useMemo(
    () => groups.filter((g) => !g.isLive && g.sessionId === activeSessionId).length,
    [groups, activeSessionId],
  );

  const userMessages = useMemo(
    () => (sessionData?.messages ?? []).filter((m) => m.role === 'user'),
    [sessionData],
  );

  // Load session list on mount
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

  // Re-fetch session detail when completedGroupCount changes
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    client.rpc.sessions
      .get({ id: activeSessionId })
      .then((res) => {
        if (!cancelled) setSessionData(res as SessionData);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, client]);

  const appendEvent = useCallback((evt: ActivityEvent) => {
    setGroups((prev) => {
      // cron.fired: standalone group, not part of a turn
      if (evt.type === 'cron.fired') {
        const g: ConversationGroup = {
          id: evt.id,
          sessionId: evt.sessionId,
          sessionTitle: evt.sessionTitle,
          startedAt: evt.timestamp,
          completedAt: evt.timestamp,
          turnCount: null,
          events: [evt],
          isLive: false,
        };
        return [g, ...prev].slice(0, MAX_EVENTS);
      }

      // Find existing live group for this session
      const liveIdx = prev.findIndex((g) => g.sessionId === evt.sessionId && g.isLive);
      if (liveIdx >= 0) {
        const done = evt.type === 'done';
        return prev.map((g, i) => {
          if (i !== liveIdx) return g;
          return {
            ...g,
            events: [...g.events, evt],
            isLive: !done,
            completedAt: done ? evt.timestamp : null,
            turnCount: done ? ((evt.raw as { turnCount?: number }).turnCount ?? null) : g.turnCount,
          };
        });
      }

      // Start a new group
      const newGroup: ConversationGroup = {
        id: `${evt.sessionId}-${evt.timestamp}`,
        sessionId: evt.sessionId,
        sessionTitle: evt.sessionTitle,
        startedAt: evt.timestamp,
        completedAt: evt.type === 'done' ? evt.timestamp : null,
        turnCount:
          evt.type === 'done' ? ((evt.raw as { turnCount?: number }).turnCount ?? null) : null,
        events: [evt],
        isLive: evt.type !== 'done',
      };
      return [newGroup, ...prev].slice(0, MAX_EVENTS);
    });
  }, []);

  // Subscribe to SSE for the active session
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

  const filtered = groups.filter((group) => {
    if (!groupMatchesFilter(group, typeFilter)) return false;
    if (sessionFilter && group.sessionId !== sessionFilter) return false;
    return true;
  });

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

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        fontFamily: 'var(--font-display)',
      }}
    >
      {/* Toolbar */}
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
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Activity
        </span>
        <select
          value={sessionFilter ?? ''}
          onChange={(e) => setSessionFilter(e.target.value || null)}
          style={{
            background: 'var(--bg-overlay)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            padding: '3px 8px',
            cursor: 'pointer',
            outline: 'none',
            minWidth: 180,
          }}
        >
          <option value="">Most recent session</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ?? s.id.slice(0, 12)}
            </option>
          ))}
        </select>
      </div>

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
        {TYPE_FILTERS.map((f) => {
          const active = typeFilter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => setTypeFilter(f.value)}
              style={{
                padding: '3px 10px',
                fontSize: 12,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                background: active ? 'var(--bg-overlay)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
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
          filtered.map((group) => {
            const toolCount = group.events.filter((e) => e.type === 'tool_start').length;
            const hasError = group.events.some((e) => e.type === 'error');
            const session = group.sessionTitle ?? group.sessionId.slice(0, 8);
            const toolPart =
              toolCount > 0 ? ` · ${toolCount} tool call${toolCount !== 1 ? 's' : ''}` : '';
            const userMsg = group.turnCount != null ? userMessages[group.turnCount - 1] : null;
            const promptText = userMsg?.content
              ? userMsg.content.trim().replace(/\s+/g, ' ')
              : null;
            const MAX_PROMPT = 60;
            const truncatedPrompt = promptText
              ? promptText.length > MAX_PROMPT
                ? `${promptText.slice(0, MAX_PROMPT)}…`
                : promptText
              : null;
            const groupLabel = truncatedPrompt
              ? `Turn ${group.turnCount}: ${truncatedPrompt}${toolPart}`
              : `${session}${group.turnCount != null ? ` · Turn ${group.turnCount}` : ''}${toolPart}`;
            const expandedGroup = expandedGroupId === group.id;

            const dotBg = group.isLive
              ? 'var(--accent)'
              : hasError
                ? 'var(--error)'
                : 'var(--success)';

            return (
              <div key={group.id} style={{ marginBottom: 6 }}>
                <button
                  type="button"
                  onClick={() => setExpandedGroupId(expandedGroup ? null : group.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '8px 12px',
                    background: 'transparent',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: expandedGroup
                      ? 'var(--radius-sm) var(--radius-sm) 0 0'
                      : 'var(--radius-sm)',
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {/* Dot indicator */}
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: dotBg,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        flexShrink: 0,
                      }}
                    >
                      {formatRelative(group.startedAt)}
                    </span>
                    {/* Status badge */}
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-sm)',
                        background: group.isLive
                          ? 'rgba(74,158,255,0.15)'
                          : hasError
                            ? 'rgba(255,80,80,0.15)'
                            : 'rgba(40,200,100,0.15)',
                        color: group.isLive
                          ? 'var(--accent)'
                          : hasError
                            ? 'var(--error)'
                            : 'var(--success)',
                        border: `1px solid ${group.isLive ? 'var(--accent)' : hasError ? 'var(--error)' : 'var(--success)'}`,
                        flexShrink: 0,
                      }}
                    >
                      {group.isLive ? 'live' : hasError ? 'error' : 'done'}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {groupLabel}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--text-tertiary)',
                      flexShrink: 0,
                      marginLeft: 8,
                    }}
                  >
                    {expandedGroup ? '▲' : '▼'}
                  </span>
                </button>

                {expandedGroup && (
                  <div
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderTop: 'none',
                      borderRadius: '0 0 var(--radius-sm) var(--radius-sm)',
                      overflow: 'hidden',
                    }}
                  >
                    {group.events.map((evt) => {
                      const expandedEvt = expandedEventId === evt.id;
                      const evtDotBg = EVENT_TYPE_DOT_COLORS[evt.type];
                      const evtTagBg = EVENT_TYPE_COLORS[evt.type];
                      const evtTagColor = EVENT_TYPE_TEXT_COLORS[evt.type];
                      return (
                        <div key={evt.id}>
                          <button
                            type="button"
                            onClick={() => setExpandedEventId(expandedEvt ? null : evt.id)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              width: '100%',
                              padding: '6px 12px',
                              background: expandedEvt ? 'var(--bg-overlay)' : 'transparent',
                              border: 'none',
                              borderBottom: '1px solid var(--border-subtle)',
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            <span
                              style={{
                                display: 'inline-block',
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                flexShrink: 0,
                                background: evtDotBg,
                              }}
                            />
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: '1px 5px',
                                borderRadius: 'var(--radius-sm)',
                                background: evtTagBg,
                                color: evtTagColor,
                                flexShrink: 0,
                              }}
                            >
                              {evt.type}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: 'var(--text-secondary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {evt.summary}
                            </span>
                          </button>
                          {expandedEvt && <EventDetail event={evt} />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
