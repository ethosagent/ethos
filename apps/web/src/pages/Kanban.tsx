import { App as AntApp, Button, Input, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Board, TaskDrawer } from '../components/kanban/KanbanBoard';
import { rpc } from '../rpc';

export function Kanban() {
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
  });

  const teams = teamsQuery.data?.teams ?? [];
  const activeTeam = selectedTeam ?? (teams.length === 1 ? (teams[0]?.name ?? null) : null);

  const boardQuery = useQuery({
    queryKey: ['kanban', 'board', activeTeam],
    queryFn: () => rpc.kanban.getBoard({ team: activeTeam ?? '' }),
    enabled: activeTeam !== null,
    refetchInterval: 3_000,
  });

  const board = boardQuery.data?.board ?? null;
  const selectedTask =
    board && selectedTaskId ? (board.tasks.find((t) => t.id === selectedTaskId) ?? null) : null;

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Kanban
        </Typography.Title>
        <span style={{ flex: 1 }} />
        {teams.length > 1 && (
          <Select
            value={activeTeam}
            onChange={setSelectedTeam}
            style={{ minWidth: 160 }}
            placeholder="Select board"
            options={teams.map((t) => ({ label: t.name, value: t.name }))}
          />
        )}
        {activeTeam && (
          <>
            <Button size="small" onClick={() => setShowCreateTask((v) => !v)}>
              {showCreateTask ? 'Cancel' : 'New task'}
            </Button>
            <Button
              size="small"
              type={showArchived ? 'primary' : 'default'}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? 'Hide archived' : 'Archived'}
            </Button>
          </>
        )}
      </header>

      {teams.length === 0 && (
        <Typography.Text type="secondary">
          No boards found. Start an agent with ethos serve to create the global board.
        </Typography.Text>
      )}

      {showCreateTask && activeTeam && (
        <CreateTaskForm teamName={activeTeam} onDone={() => setShowCreateTask(false)} />
      )}

      {board && activeTeam && (
        <Board
          snapshot={board}
          teamName={activeTeam}
          showArchived={showArchived}
          onSelect={setSelectedTaskId}
        />
      )}

      {board && activeTeam && (
        <TaskDrawer
          task={selectedTask}
          board={board}
          teamName={activeTeam}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}

function CreateTaskForm({ teamName, onDone }: { teamName: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState<string | undefined>();

  const agentsQuery = useQuery({
    queryKey: ['kanban', 'agents', teamName],
    queryFn: () => rpc.kanban.listAgents({ team: teamName }),
  });

  const createMut = useMutation({
    mutationFn: () =>
      rpc.kanban.createTask({ team: teamName, title, body: body || undefined, assignee }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] });
      notification.success({ message: 'Task created' });
      onDone();
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to create task',
        description: (err as Error).message,
      }),
  });

  const agents = agentsQuery.data?.agents ?? [];

  return (
    <div
      style={{
        border: '1px solid var(--ethos-border, #d9d9d9)',
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <Input
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <Input.TextArea
        placeholder="Description (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        style={{ marginBottom: 8 }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Select
          value={assignee}
          onChange={setAssignee}
          placeholder="Assign to..."
          allowClear
          style={{ minWidth: 160 }}
          options={agents.map((a) => ({
            label: `${a.displayName}${a.online ? '' : ' (offline)'}`,
            value: a.personalityId,
            disabled: !a.online,
          }))}
        />
        <span style={{ flex: 1 }} />
        <Button onClick={onDone}>Cancel</Button>
        <Button
          type="primary"
          onClick={() => createMut.mutate()}
          loading={createMut.isPending}
          disabled={!title.trim()}
        >
          Create
        </Button>
      </div>
    </div>
  );
}
