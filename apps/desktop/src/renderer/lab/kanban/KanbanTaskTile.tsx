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

export function KanbanTaskTile({ task, onClick }: KanbanTaskTileProps) {
  const pStyle = priorityStyles[task.priority] ?? defaultPStyle;
  const isRunning = task.status === 'running';
  const isBlocked = task.status === 'blocked';

  return (
    <>
      <style>{`@keyframes ethos-pulse { 0%, 100% { opacity: 0.4 } 50% { opacity: 1 } }`}</style>
      <button
        type="button"
        onClick={() => onClick(task.id)}
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          padding: '12px 14px',
          marginBottom: 12,
          cursor: 'pointer',
          borderLeft: isRunning
            ? '2px solid var(--info)'
            : isBlocked
              ? '2px solid var(--error)'
              : '1px solid var(--border-subtle)',
          animation: isRunning ? 'ethos-pulse 1.4s ease-in-out infinite' : undefined,
          textAlign: 'left',
          width: '100%',
          display: 'block',
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
              borderRadius: 4,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            P{task.priority}
          </span>
        </div>

        {task.assignee && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
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
          </div>
        )}
      </button>
    </>
  );
}
