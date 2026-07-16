import type { SseEvent } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Empty, Select, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
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

const DOT_CLASS_MAP: Record<ActivityEvent['type'], string> = {
  tool_start: 'tool_start',
  tool_end: 'tool_end',
  done: 'done',
  error: 'error',
  'tool.approval_required': 'approval',
  'cron.fired': 'cron',
};

const TYPE_COLORS: Record<ActivityEvent['type'], string> = {
  tool_start: 'blue',
  tool_end: 'blue',
  done: 'green',
  error: 'red',
  'tool.approval_required': 'orange',
  'cron.fired': 'purple',
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

export function Activity() {
  const [groups, setGroups] = useState<ConversationGroup[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const { data: sessionsData, isLoading } = useQuery({
    queryKey: ['sessions', 'list', { limit: 10 }],
    queryFn: () => rpc.sessions.list({ limit: 10 }),
  });

  const sessions = sessionsData?.items ?? [];

  const activeSessionId = sessionFilter ?? sessions[0]?.id ?? null;

  const completedGroupCount = useMemo(
    () => groups.filter((g) => !g.isLive && g.sessionId === activeSessionId).length,
    [groups, activeSessionId],
  );

  const { data: sessionData } = useQuery({
    queryKey: ['sessions', 'get', activeSessionId, completedGroupCount],
    queryFn: () => rpc.sessions.get({ id: activeSessionId ?? '' }),
    enabled: !!activeSessionId,
  });

  const userMessages = useMemo(
    () => (sessionData?.messages ?? []).filter((m) => m.role === 'user'),
    [sessionData],
  );

  // Phase 0 — per-session context anatomy (system / tools / messages token
  // slices + cache-hit rate), aggregated from observability llm_call spans.
  const { data: anatomyData } = useQuery({
    queryKey: ['sessions', 'contextAnatomy', activeSessionId, completedGroupCount],
    queryFn: () => rpc.sessions.contextAnatomy({ id: activeSessionId ?? '' }),
    enabled: !!activeSessionId,
  });
  const anatomy = anatomyData?.anatomy ?? null;

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

  const filtered = groups.filter((group) => {
    if (!groupMatchesFilter(group, typeFilter)) return false;
    if (sessionFilter && group.sessionId !== sessionFilter) return false;
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

      {anatomy && (
        <div className="activity-context-anatomy">
          <span className="aca-title">Context</span>
          <Tag>system {anatomy.system.toLocaleString()}</Tag>
          <Tag>tools {anatomy.tools.toLocaleString()}</Tag>
          <Tag>messages {anatomy.messages.toLocaleString()}</Tag>
          <Tag color="blue">total {anatomy.total.toLocaleString()} tok</Tag>
          <Tag color="green">cache {Math.round(anatomy.cacheHitRate * 100)}%</Tag>
        </div>
      )}

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
          filtered.map((group) => {
            const toolCount = group.events.filter((e) => e.type === 'tool_start').length;
            const hasError = group.events.some((e) => e.type === 'error');
            const session = group.sessionTitle || group.sessionId.slice(0, 8);
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

            return (
              <div key={group.id} className="activity-group">
                <button
                  type="button"
                  className={`activity-group-header${expandedGroup ? ' activity-group-header--expanded' : ''}`}
                  onClick={() => setExpandedGroupId(expandedGroup ? null : group.id)}
                >
                  <div className="activity-group-meta">
                    <span
                      className={`activity-event-dot activity-event-dot--${group.isLive ? 'tool_start' : hasError ? 'error' : 'done'}${group.isLive ? ' activity-event-dot--pulse' : ''}`}
                    />
                    <span className="activity-group-time">{formatRelative(group.startedAt)}</span>
                    <Tag color={group.isLive ? 'processing' : hasError ? 'red' : 'green'}>
                      {group.isLive ? 'live' : hasError ? 'error' : 'done'}
                    </Tag>
                    <span className="activity-group-summary">{groupLabel}</span>
                  </div>
                  <span className="activity-group-chevron">{expandedGroup ? '▲' : '▼'}</span>
                </button>

                {expandedGroup && (
                  <div className="activity-group-events">
                    {group.events.map((evt) => {
                      const expandedEvt = expandedEventId === evt.id;
                      return (
                        <div key={evt.id}>
                          <button
                            type="button"
                            className={`activity-subevent${expandedEvt ? ' activity-subevent--expanded' : ''}`}
                            onClick={() => setExpandedEventId(expandedEvt ? null : evt.id)}
                          >
                            <span
                              className={`activity-event-dot activity-event-dot--${DOT_CLASS_MAP[evt.type]}`}
                            />
                            <Tag
                              color={TYPE_COLORS[evt.type]}
                              style={{ fontSize: 11, lineHeight: '18px' }}
                            >
                              {evt.type}
                            </Tag>
                            <span className="activity-subevent-summary">{evt.summary}</span>
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
