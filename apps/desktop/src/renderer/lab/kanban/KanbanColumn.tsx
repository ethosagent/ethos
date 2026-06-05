import type { KanbanTask } from './KanbanTaskTile';
import { KanbanTaskTile } from './KanbanTaskTile';

interface KanbanColumnProps {
  name: string;
  tasks: KanbanTask[];
  onTaskClick: (id: string) => void;
}

export function KanbanColumn({ name, tasks, onTaskClick }: KanbanColumnProps) {
  return (
    <div
      style={{
        width: 220,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            letterSpacing: '0.08em',
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          ({tasks.length})
        </span>
      </div>

      <div style={{ flex: 1 }}>
        {tasks.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              color: 'var(--text-tertiary)',
              paddingTop: 24,
            }}
          >
            No tasks
          </div>
        ) : (
          tasks.map((task) => <KanbanTaskTile key={task.id} task={task} onClick={onTaskClick} />)
        )}
      </div>
    </div>
  );
}
