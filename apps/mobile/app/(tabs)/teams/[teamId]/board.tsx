import type { KanbanTaskStatus } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useRpc } from '../../../../src/api/queries';
import { teamKeys, useBoard, useKanbanSync } from '../../../../src/api/teams';
import { Chip, ChipRow, useListBottomInset } from '../../../../src/components/agents/AgentParts';
import {
  SectionTitle,
  TaskTile,
  TeamScreenHeader,
} from '../../../../src/components/teams/TeamParts';
import { Button } from '../../../../src/components/ui/Button';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import {
  columnChips,
  columnTasks,
  defaultColumn,
  recentEventRows,
  STATUS_LABEL,
  taskReasons,
  tileMeta,
} from '../../../../src/features/teams/board';
import type { RowData } from '../../../../src/lib/row';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * team-board (§6): one column at a time, picked by chips carrying counts in
 * the web's order; tiles, then `Recent events`. No drag on a phone — status
 * changes happen in the task. `+ New task` → `kanban.createTask` (title and
 * optional acceptance criteria; the coordinator dispatches it).
 */
export default function TeamBoard() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const router = useRouter();
  const bottomInset = useListBottomInset();
  const live = useKanbanSync(teamId);
  const board = useBoard(teamId);
  const [picked, setPicked] = useState<KanbanTaskStatus | null>(null);
  const [composing, setComposing] = useState(false);

  const snapshot = board.data?.board;
  const tasks = snapshot?.tasks ?? null;
  const column = picked ?? (tasks ? defaultColumn(tasks) : 'todo');
  const reasons = taskReasons(snapshot?.recentEvents ?? []);
  const inColumn = tasks ? columnTasks(tasks, column) : [];

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={board.isRefetching} onRefresh={() => void board.refetch()} />
      }
    >
      <TeamScreenHeader team={teamId} segment="board" />
      <ChipRow>
        {columnChips(tasks).map((c) => (
          <Chip
            key={c.status}
            label={c.label}
            selected={c.status === column}
            onPress={() => setPicked(c.status)}
          />
        ))}
      </ChipRow>
      {board.error ? <Row wrap row={errorRow(board.error, 'getBoard')} /> : null}
      {board.isPending ? <Skeleton rows={3} height={72} /> : null}
      {tasks && inColumn.length === 0 ? (
        <View style={styles.empty}>
          <Text style={type.small}>Nothing in {STATUS_LABEL[column]}.</Text>
          {column === 'todo' && !composing ? (
            <Button label="New task" onPress={() => setComposing(true)} />
          ) : null}
        </View>
      ) : null}
      {inColumn.map((t) => (
        <TaskTile
          key={t.id}
          task={t}
          reason={reasons.get(t.id)}
          meta={tileMeta(t)}
          onPress={() =>
            router.push({
              pathname: '/teams/[teamId]/task/[taskId]',
              params: { teamId, taskId: t.id },
            })
          }
        />
      ))}
      {tasks ? (
        composing ? (
          <NewTaskForm team={teamId} onDone={() => setComposing(false)} />
        ) : (
          <View style={styles.pad}>
            <Button label="+ New task" onPress={() => setComposing(true)} />
          </View>
        )
      ) : null}
      {snapshot ? (
        <>
          <SectionTitle title={live ? 'Recent events' : 'Recent events · not live'} />
          {recentEventRows(snapshot.recentEvents, snapshot.tasks).map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are rebuilt per board snapshot
            <Row key={i} row={r} />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function NewTaskForm({ team, onDone }: { team: string; onDone: () => void }) {
  const rpc = useRpc();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [criteria, setCriteria] = useState('');
  const [failure, setFailure] = useState<RowData | null>(null);
  const create = useMutation({
    mutationFn: () =>
      rpc.kanban.createTask({
        team,
        title: title.trim(),
        priority: 0,
        ...(criteria.trim() ? { acceptanceCriteria: criteria.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamKeys.board(team) });
      onDone();
    },
    onError: (err) => setFailure(errorRow(err, 'kanban.createTask')),
  });
  return (
    <View style={styles.form}>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Title"
        placeholderTextColor={color.textTertiary}
        style={[type.body, styles.input]}
        autoFocus
      />
      <TextInput
        value={criteria}
        onChangeText={setCriteria}
        placeholder="Acceptance criteria (one per line, optional)"
        placeholderTextColor={color.textTertiary}
        multiline
        style={[type.body, styles.input, styles.multiline]}
      />
      {failure ? <Row wrap row={failure} /> : null}
      <View style={styles.buttons}>
        <Button label="Cancel" disabled={create.isPending} onPress={onDone} />
        <Button
          label={create.isPending ? 'Creating…' : 'Create'}
          disabled={!title.trim() || create.isPending}
          onPress={() => {
            setFailure(null);
            create.mutate();
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  pad: { paddingHorizontal: 16, paddingTop: 8 },
  empty: { paddingHorizontal: 16, paddingVertical: 12, gap: 10, alignItems: 'flex-start' },
  form: { padding: 16, gap: 8 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
  },
  multiline: { minHeight: 88, paddingTop: 10, textAlignVertical: 'top' },
  buttons: { flexDirection: 'row', gap: 12 },
});
