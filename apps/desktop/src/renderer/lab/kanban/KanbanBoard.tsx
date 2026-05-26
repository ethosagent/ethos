import { useMemo } from 'react';
import { KanbanColumn } from './KanbanColumn';
import type { KanbanTask } from './KanbanTaskTile';

interface KanbanBoardProps {
  tasks: KanbanTask[];
  onTaskClick: (id: string) => void;
}

const COLUMNS = ['todo', 'ready', 'running', 'blocked', 'done'] as const;
const COLUMN_LABELS: Record<string, string> = {
  todo: 'TODO',
  ready: 'READY',
  running: 'RUNNING',
  blocked: 'BLOCKED',
  done: 'DONE',
};

export function KanbanBoard({ tasks, onTaskClick }: KanbanBoardProps) {
  const grouped = useMemo(() => {
    const map: Record<string, KanbanTask[]> = {};
    for (const col of COLUMNS) map[col] = [];
    for (const task of tasks) {
      const key = COLUMNS.includes(task.status as (typeof COLUMNS)[number]) ? task.status : 'todo';
      map[key].push(task);
    }
    return map;
  }, [tasks]);

  return (
    <div
      style={{
        overflowX: 'auto',
        flex: 1,
        padding: '0 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          minWidth: COLUMNS.length * 220 + (COLUMNS.length - 1) * 12,
        }}
      >
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col}
            name={COLUMN_LABELS[col]}
            tasks={grouped[col]}
            onTaskClick={onTaskClick}
          />
        ))}
      </div>
    </div>
  );
}
