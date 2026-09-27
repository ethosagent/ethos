import { humanDuration } from '@ethosagent/chat-state';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useRpc } from '../../../../src/api/queries';
import { useTeamDetail } from '../../../../src/api/teams';
import { useListBottomInset } from '../../../../src/components/agents/AgentParts';
import { CommandLine, SectionTitle, StatusDot } from '../../../../src/components/teams/TeamParts';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { restartCommand } from '../../../../src/features/teams/overview';
import type { RowData } from '../../../../src/lib/row';
import { registerForPush } from '../../../../src/push/registration';
import { usePushPrefs } from '../../../../src/state/push-prefs';
import { color, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * team-settings (§6): read-mostly. Supervisor state and a Restart STATEMENT —
 * the CLI in mono, not a control: no supervisor control surface exists
 * (teams-as-a-scope D13), and a control that cannot work is not rendered.
 * Dispatch kv. Notifications on this phone: the server has one team category
 * (`teamAttention` — a task going `blocked` or `needs_revision`, for every
 * team), so that is the one switch; a per-team or every-completion switch
 * would have nothing on the server to obey it, and is not rendered.
 */
export default function TeamSettings() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const rpc = useRpc();
  const bottomInset = useListBottomInset();
  const detail = useTeamDetail(teamId);
  const team = detail.data;
  const categories = usePushPrefs((s) => s.categories);
  const setCategories = usePushPrefs((s) => s.set);
  const [busy, setBusy] = useState(false);
  const [pushRow, setPushRow] = useState<RowData | null>(null);

  const started = team?.startedAt ? Date.parse(team.startedAt) : Number.NaN;
  const supervisor = team?.runtime
    ? `Running · pid ${team.runtime.supervisorPid}${Number.isFinite(started) ? ` · up ${humanDuration(Date.now() - started)}` : ''}`
    : team?.health === 'stale'
      ? 'Stale'
      : 'Stopped';

  const toggle = async (value: boolean): Promise<void> => {
    const next = { ...categories, teamAttention: value };
    setCategories(next);
    setBusy(true);
    const result = await registerForPush(rpc, next);
    setPushRow(
      result.registered
        ? { glyph: '✓', word: 'push', subject: 'Expo', result: 'registered' }
        : { glyph: '✗', word: 'push', subject: 'Expo', result: result.reason },
    );
    setBusy(false);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      refreshControl={
        <RefreshControl refreshing={detail.isRefetching} onRefresh={() => void detail.refetch()} />
      }
    >
      <Stack.Screen options={{ title: 'Settings', headerBackTitle: teamId }} />
      {detail.error ? <Row wrap row={errorRow(detail.error, 'teams.get')} /> : null}
      {detail.isPending ? <Skeleton rows={4} height={36} /> : null}
      {team ? (
        <>
          <SectionTitle title="Supervisor" />
          <View style={styles.kv}>
            <StatusDot
              state={team.health === 'running' ? 'live' : team.health === 'stale' ? 'warn' : 'dim'}
            />
            <Text style={type.body}>{supervisor}</Text>
          </View>
          <View style={styles.statement}>
            <Text style={type.body}>Restart</Text>
            <Text style={type.small}>Run on the server:</Text>
            <CommandLine command={restartCommand(team.name)} />
          </View>

          <SectionTitle title="Dispatch" />
          <Kv k="mode" v={team.dispatchMode} />
          <Kv k="coordinator" v={team.coordinator ?? '—'} />
          <Kv k="poll" v={humanDuration(team.kanban.pollMs)} />
          <Kv k="stale after" v={humanDuration(team.kanban.staleMs)} />
          <Kv k="trust" v={team.trustPolicy?.mode ?? 'flat'} />
          <Kv k="manifest" v={team.manifestPath} />
        </>
      ) : null}

      <SectionTitle title="Notifications on this phone" />
      <View style={styles.toggle}>
        <View style={styles.flex}>
          <Text style={type.body}>Blocked tasks and needs revision</Text>
          <Text style={type.small}>Every team on this server · also in More › Settings</Text>
        </View>
        <Switch
          accessibilityLabel="Team attention notifications"
          value={categories.teamAttention}
          disabled={busy}
          trackColor={{ true: color.chrome }}
          onValueChange={(v) => void toggle(v)}
        />
      </View>
      {pushRow ? <Row row={pushRow} /> : null}
    </ScrollView>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv} accessible>
      <Text style={[type.small, styles.key]}>{k}</Text>
      <Text style={[type.mono, styles.flex]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
  kv: { minHeight: 36, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
  key: { width: 112, flexShrink: 0 },
  statement: { paddingHorizontal: 16, paddingVertical: 8, gap: 4 },
  toggle: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
