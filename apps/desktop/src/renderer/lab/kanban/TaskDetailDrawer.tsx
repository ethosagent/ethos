import { useState } from 'react';
import { Chip } from '../../ui/Chip';
import { DrawerShell } from '../../ui/DrawerShell';
import type { KanbanTask } from './KanbanTaskTile';

interface TaskDetailDrawerProps {
  task: KanbanTask | null;
  open: boolean;
  onClose: () => void;
  onStatusChange: (
    taskId: string,
    status:
      | 'todo'
      | 'ready'
      | 'running'
      | 'blocked'
      | 'done'
      | 'archived'
      | 'scheduled'
      | 'failed'
      | 'needs_revision',
  ) => void;
}

const STATUSES = [
  'todo',
  'ready',
  'running',
  'blocked',
  'done',
  'archived',
  'scheduled',
  'failed',
  'needs_revision',
] as const;

const STATUS_VARIANT: Record<string, 'success' | 'info' | 'warning' | 'neutral' | 'error'> = {
  todo: 'neutral',
  ready: 'info',
  running: 'info',
  blocked: 'error',
  done: 'success',
};

export function TaskDetailDrawer({ task, open, onClose, onStatusChange }: TaskDetailDrawerProps) {
  const [selectedStatus, setSelectedStatus] = useState('');

  if (!task) return null;

  const otherStatuses = STATUSES.filter((s) => s !== task.status);

  return (
    <DrawerShell open={open} title="Task Details" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
          {task.title}
        </div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{task.title}</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Chip
            label={task.status.toUpperCase()}
            variant={STATUS_VARIANT[task.status] ?? 'neutral'}
          />
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Move to:</span>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            style={{
              height: 28,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              background: 'var(--bg-base)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              padding: '0 8px',
              outline: 'none',
            }}
          >
            <option value="">--</option>
            {otherStatuses.map((s) => (
              <option key={s} value={s}>
                {s.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        {task.assignee && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{task.assignee}</span>
          </div>
        )}

        <button
          type="button"
          disabled={!selectedStatus}
          onClick={() => {
            if (selectedStatus) {
              onStatusChange(task.id, selectedStatus as (typeof STATUSES)[number]);
              setSelectedStatus('');
            }
          }}
          style={{
            height: 36,
            width: '100%',
            background: selectedStatus ? 'var(--accent)' : 'var(--bg-overlay)',
            color: selectedStatus ? '#fff' : 'var(--text-tertiary)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            fontWeight: 500,
            cursor: selectedStatus ? 'pointer' : 'default',
            transition: 'background var(--motion-fast) var(--ease)',
          }}
        >
          Update status
        </button>
      </div>
    </DrawerShell>
  );
}
