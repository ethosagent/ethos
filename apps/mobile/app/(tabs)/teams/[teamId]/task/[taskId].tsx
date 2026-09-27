import { formatRelative } from '@ethosagent/chat-state';
import type { KanbanTaskStatus } from '@ethosagent/web-contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { selectionAsync } from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { errorRow } from '../../../../../src/api/errors';
import { useRpc } from '../../../../../src/api/queries';
import { teamKeys, useBoard, useKanbanSync } from '../../../../../src/api/teams';
import { useListBottomInset } from '../../../../../src/components/agents/AgentParts';
import { SectionTitle } from '../../../../../src/components/teams/TeamParts';
import { Button } from '../../../../../src/components/ui/Button';
import { Mark } from '../../../../../src/components/ui/Mark';
import { RouteError } from '../../../../../src/components/ui/RouteError';
import { Row } from '../../../../../src/components/ui/Row';
import { Skeleton } from '../../../../../src/components/ui/Skeleton';
import { STATUS_LABEL } from '../../../../../src/features/teams/board';
import {
  ACTION_TARGET,
  APPROVE_REASON,
  auditRows,
  criteriaRows,
  decisionSettled,
  retriesLabel,
  type TaskAction,
  taskActions,
  verifierVerdict,
  wasBypassed,
} from '../../../../../src/features/teams/task';
import type { RowData } from '../../../../../src/lib/row';
import { color, radius, type } from '../../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

interface Pending {
  action: TaskAction;
  target: KanbanTaskStatus;
  fromStatus: KanbanTaskStatus;
  fromUpdatedAt: string;
}

/**
 * task (§6): title, kv, Acceptance criteria, Verifier said, the audit trail
 * scrolling beneath a pinned action row — Send back with note (`--error`
 * text) and Approve completion (accent text), equal-weight bordered 44 pt
 * buttons, neither filled (§12 amendment 15). On tap both disable, `deciding…`
 * shows above the row, and the row resolves when the task's status changes.
 * The actor is stamped server-side (`human:key:<name>`, S9).
 */
export default function TaskScreen() {
  const { teamId, taskId } = useLocalSearchParams<{ teamId: string; taskId: string }>();
  const rpc = useRpc();
  const queryClient = useQueryClient();
  const bottomInset = useListBottomInset();
  useKanbanSync(teamId);
  const board = useBoard(teamId);
  const detail = useQuery({
    queryKey: teamKeys.task(teamId, taskId),
    queryFn: () => rpc.kanban.getTask({ team: teamId, taskId }),
  });
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<RowData | null>(null);
  // A ref, not the state: two taps inside one frame both see stale state.
  const sent = useRef(false);

  const task = detail.data?.task;
  const fromList = board.data?.board.tasks.find((t) => t.id === taskId);
  const title = task?.title ?? fromList?.title ?? `#${taskId.slice(0, 8)}`;
  const events = board.data?.board.recentEvents ?? [];

  useEffect(() => {
    if (pending && task && decisionSettled(pending, task)) {
      sent.current = false;
      setPending(null);
      setNote('');
    }
  }, [pending, task]);

  const decide = async (action: TaskAction): Promise<void> => {
    if (!task || sent.current) return;
    sent.current = true;
    void selectionAsync();
    setFailure(null);
    setPending({
      action,
      target: ACTION_TARGET[action],
      fromStatus: task.status,
      fromUpdatedAt: task.updatedAt,
    });
    try {
      if (action === 'send-back') {
        const reason = note.trim();
        await rpc.kanban.addComment({ team: teamId, taskId, body: reason });
        await rpc.kanban.updateStatus({ team: teamId, taskId, status: 'needs_revision', reason });
      } else {
        await rpc.kanban.updateStatus({
          team: teamId,
          taskId,
          status: 'done',
          reason: APPROVE_REASON,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: teamKeys.task(teamId, taskId) }),
        queryClient.invalidateQueries({ queryKey: teamKeys.board(teamId) }),
        queryClient.invalidateQueries({ queryKey: teamKeys.ledger(teamId) }),
        queryClient.invalidateQueries({ queryKey: ['teams'] }),
      ]);
    } catch (err) {
      sent.current = false;
      setPending(null);
      setFailure(errorRow(err, action === 'approve' ? 'kanban.updateStatus' : 'kanban.addComment'));
    }
  };

  const actions = task ? taskActions(task.status) : [];
  const verdict = task ? verifierVerdict(events, taskId, task.status) : null;
  const criteria = task
    ? criteriaRows(task.acceptanceCriteria, task.status, wasBypassed(events, taskId))
    : [];
  const created = events.find((e) => e.taskId === taskId && e.kind === 'created');
  const deciding = pending !== null;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: `#${taskId.slice(0, 8)}`, headerBackTitle: teamId }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: actions.length > 0 ? 16 : bottomInset }}
      >
        <Text style={[type.h4, styles.title]} accessibilityRole="header">
          {title}
        </Text>
        {detail.error ? <Row wrap row={errorRow(detail.error, 'getTask')} /> : null}
        {detail.isPending ? <Skeleton rows={4} height={36} /> : null}
        {task ? (
          <>
            <View style={styles.kvGroup}>
              <Kv k="status" v={STATUS_LABEL[task.status]} mono />
              <View style={styles.kv}>
                <Text style={[type.small, styles.key]}>assignee</Text>
                {task.assignee ? <Mark personalityId={task.assignee} size={18} /> : null}
                <Text style={type.body}>{task.assignee ?? 'unassigned'}</Text>
              </View>
              <Kv k="priority" v={`p${task.priority}`} mono />
              <Kv k="retries" v={retriesLabel(task)} mono />
              <Kv
                k="created"
                v={`${created ? `${created.actor} · ` : ''}${formatRelative(task.createdAt)}`}
                mono
              />
            </View>
            {task.body ? <Text style={[type.body, styles.body]}>{task.body}</Text> : null}

            <SectionTitle title="Acceptance criteria" />
            {criteria.length === 0 ? (
              <Text style={[type.small, styles.body]}>No acceptance criteria.</Text>
            ) : (
              criteria.map((c) => (
                <Row
                  key={c.text}
                  row={{ glyph: c.glyph, word: c.word, subject: '', result: c.text }}
                />
              ))
            )}

            {verdict ? (
              <View style={styles.verifier} accessible>
                <Text style={[type.small, styles.upper]}>Verifier said</Text>
                <Text style={type.body}>{verdict.reason}</Text>
                <Text style={[type.mono, { color: color.textTertiary }]}>
                  {verdict.actor} · fail-closed · {verdict.time}
                </Text>
              </View>
            ) : null}

            <SectionTitle title="Audit trail" />
            {auditRows(events, detail.data?.comments ?? [], taskId).map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rebuilt per snapshot
              <Row key={i} row={r} />
            ))}
          </>
        ) : null}
      </ScrollView>

      {task && actions.length > 0 ? (
        <KeyboardStickyView offset={{ closed: -bottomInset, opened: 0 }}>
          <View style={styles.pinned}>
            <View style={styles.slot} accessibilityLiveRegion="polite">
              {deciding ? <Text style={type.mono}>deciding…</Text> : null}
            </View>
            {failure ? <Row wrap row={failure} /> : null}
            <TextInput
              value={note}
              onChangeText={setNote}
              editable={!deciding}
              placeholder="Note for the assignee (to send back)"
              placeholderTextColor={color.textTertiary}
              multiline
              style={[type.body, styles.input]}
            />
            <View style={styles.buttons}>
              <Button
                label="Send back with note"
                textColor={color.error}
                disabled={deciding || !note.trim()}
                onPress={() => void decide('send-back')}
              />
              <Button
                label="Approve completion"
                textColor={color.chrome}
                disabled={deciding}
                onPress={() => void decide('approve')}
              />
            </View>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}

function Kv({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.kv} accessible>
      <Text style={[type.small, styles.key]}>{k}</Text>
      <Text style={[mono ? type.mono : type.body, styles.flex]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
  upper: { textTransform: 'uppercase' },
  title: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  body: { paddingHorizontal: 16, paddingVertical: 6 },
  kvGroup: { borderBottomWidth: 1, borderBottomColor: color.borderSubtle, paddingBottom: 8 },
  kv: {
    minHeight: 36,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  key: { width: 112, flexShrink: 0 },
  verifier: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
  },
  pinned: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: color.borderSubtle,
    backgroundColor: color.bgBase,
  },
  slot: { minHeight: 28, justifyContent: 'center' },
  input: {
    minHeight: 44,
    maxHeight: 96,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  buttons: { flexDirection: 'row', gap: 12 },
});
