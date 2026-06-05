export interface KanbanTask {
  id: string;
  title: string;
  body: string;
  status: string;
  assignee: string | null;
  priority: number;
  workspaceMode: string;
  workspacePath: string | null;
  scheduledFor: string | null;
  currentRunId: string | null;
  retryCount: number;
  maxRetries: number | null;
  acceptanceCriteria: string | null;
  createdAt: string;
  updatedAt: string;
}

interface KanbanTaskTileProps {
  task: KanbanTask;
  onClick: (id: string) => void;
}

const priorityStyles: Record<number, { color: string; bg: string }> = {
  1: { color: 'var(--error)', bg: 'rgba(248,113,113,0.12)' },
  2: { color: 'var(--warning)', bg: 'rgba(245,158,11,0.12)' },
  3: { color: 'var(--text-tertiary)', bg: 'var(--bg-overlay)' },
};

const defaultPStyle = { color: 'var(--text-tertiary)', bg: 'var(--bg-overlay)' };

const STATUS_BADGE: Record<string, { color: string; bg: string }> = {
  done: { color: 'var(--success, #4ade80)', bg: 'rgba(74, 222, 128, 0.10)' },
  running: { color: 'var(--info, #4a9eff)', bg: 'rgba(74, 158, 255, 0.10)' },
  blocked: { color: 'var(--error, #f87171)', bg: 'rgba(248, 113, 113, 0.10)' },
  needs_revision: { color: 'var(--warning, #f59e0b)', bg: 'rgba(245, 158, 11, 0.10)' },
  ready: { color: 'var(--success, #4ade80)', bg: 'rgba(74, 222, 128, 0.10)' },
};

const DEFAULT_BADGE = { color: 'var(--text-tertiary)', bg: 'var(--bg-overlay)' };

export function KanbanTaskTile({ task, onClick }: KanbanTaskTileProps) {
  const pStyle = priorityStyles[task.priority] ?? defaultPStyle;
  const badge = STATUS_BADGE[task.status] ?? DEFAULT_BADGE;

  return (
    <button
      type="button"
      onClick={() => onClick(task.id)}
      className="kanban-task-tile"
      style={{
        backgroundColor: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        padding: 12,
        marginBottom: 8,
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        display: 'block',
        transition: 'border-color 80ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-strong)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {task.title}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: pStyle.color,
            backgroundColor: pStyle.bg,
            borderRadius: 'var(--radius-sm)',
            padding: '4px 8px',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          P{task.priority}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 8,
        }}
      >
        {/* Status badge */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            color: badge.color,
            backgroundColor: badge.bg,
            padding: '2px 8px',
            borderRadius: 'var(--radius-sm)',
            whiteSpace: 'nowrap',
          }}
        >
          {task.status.replace('_', ' ')}
        </span>

        {task.assignee && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {task.assignee}
          </span>
        )}
      </div>
    </button>
  );
}
