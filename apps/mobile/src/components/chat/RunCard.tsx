import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../api/errors';
import { useRpc } from '../../api/queries';
import { type RunBorder, runCardModel } from '../../features/teams/run-card';
import type { RowData } from '../../lib/row';
import { useChatStore } from '../../state/chat-store';
import { color, radius, type } from '../../theme/tokens';
import { Button } from '../ui/Button';
import { Row } from '../ui/Row';

const BORDER: Record<RunBorder, string> = {
  border: color.borderSubtle,
  warning: color.warning,
  success: color.success,
  error: color.error,
};

/**
 * A delegated run where the handoff happened (D10, §3): runner badge, the run
 * label, the task line, the live `now` line and elapsed, Stop run. State from
 * `ChatState.runs` (the `pi-run-reducer`, fed by `run.update` and seeded from
 * `tasks.list` on open); the label and prompt are the job row's static half
 * (`tasks.get`, asked once). Border colour by state, teal on the badge only,
 * no stripe (§12 amendment 16).
 */
export function RunAnchor({ jobId }: { jobId: string }) {
  const run = useChatStore((s) => s.chat.runs.byId[jobId]);
  const rpc = useRpc();
  const detail = useQuery({
    queryKey: ['tasks', 'get', jobId],
    queryFn: () => rpc.tasks.get({ id: jobId }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: !!run,
  });
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<RowData | null>(null);
  if (!run) return null;
  const view = runCardModel(run, detail.data?.label ?? null);
  const prompt = detail.data?.prompt ?? null;

  const stop = async (): Promise<void> => {
    setStopping(true);
    setFailure(null);
    try {
      const res = await rpc.tasks.cancel({ id: jobId });
      if (!res.ok) setFailure({ glyph: '✗', word: 'stop', subject: jobId, result: 'refused' });
    } catch (err) {
      setFailure(errorRow(err, 'tasks.cancel'));
    }
    // The terminal `run.update` is what ends the card; until then it stays armed.
    setStopping(false);
  };

  return (
    <View
      style={[styles.card, { borderColor: BORDER[view.border] }]}
      accessibilityLabel={`${view.header}, ${view.statusLine}`}
    >
      <View style={styles.header}>
        <Text
          style={[
            type.mono,
            styles.badge,
            view.badgeColor ? { color: view.badgeColor, borderColor: view.badgeColor } : null,
          ]}
        >
          {view.badge}
        </Text>
        <Text style={[type.mono, styles.flex]} numberOfLines={1}>
          {view.header}
        </Text>
        <Text style={[type.mono, { color: color.textTertiary }]}>{view.statusLine}</Text>
      </View>
      {view.title || prompt ? (
        <Text style={type.body} numberOfLines={2}>
          {view.title ?? prompt}
        </Text>
      ) : null}
      <View style={styles.now}>
        <Text style={{ color: view.nowPulsing ? color.chrome : color.textTertiary }}>●</Text>
        <Text style={[type.mono, styles.flex]} numberOfLines={1}>
          now · {view.nowLine}
        </Text>
      </View>
      {failure ? <Row wrap row={failure} /> : null}
      {view.canStop ? (
        <View style={styles.buttons}>
          <Button
            label="Stop run"
            textColor={color.error}
            disabled={stopping}
            onPress={() => void stop()}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    padding: 12,
    gap: 8,
    marginVertical: 6,
    borderWidth: 1,
    borderRadius: radius.md,
    backgroundColor: color.bgElevated,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: {
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
  },
  now: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  buttons: { flexDirection: 'row' },
});
