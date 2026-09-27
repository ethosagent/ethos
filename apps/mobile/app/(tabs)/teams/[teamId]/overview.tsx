import { memberPresence, needsYou } from '@ethosagent/chat-state';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useBoard, useKanbanSync, useLedger, useTeamDetail } from '../../../../src/api/teams';
import { useListBottomInset } from '../../../../src/components/agents/AgentParts';
import {
  CommandLine,
  type DotState,
  SectionTitle,
  StatusDot,
  TaskTile,
  TeamScreenHeader,
} from '../../../../src/components/teams/TeamParts';
import { Mark } from '../../../../src/components/ui/Mark';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { taskReasons, tileMeta } from '../../../../src/features/teams/board';
import { ledgerEmptyLine, ledgerRow, statusStrip } from '../../../../src/features/teams/overview';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

const PRESENCE_DOT: Record<'ok' | 'err' | 'dim', DotState> = {
  ok: 'idle',
  err: 'blocked',
  dim: 'offline',
};

/**
 * team-overview (§6): the web's three columns stacked in attention order —
 * status strip, Members, Needs attention, Supervisor ledger. `teams.get`
 * renders the strip without waiting for the board (§11a PARTIAL).
 */
export default function TeamOverview() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const router = useRouter();
  const bottomInset = useListBottomInset();
  const { fontScale } = useWindowDimensions();
  useKanbanSync(teamId);
  const detail = useTeamDetail(teamId);
  const board = useBoard(teamId);
  const ledger = useLedger(teamId, 20);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const team = detail.data;
  const tasks = board.data?.board.tasks;
  const reasons = taskReasons(board.data?.board.recentEvents ?? []);
  // A team with no board yet answers getBoard with an error; the strip then
  // says `no board yet` rather than showing the failure as the whole screen.
  const boardTasks = board.error ? null : tasks;
  const attention = tasks ? needsYou(tasks) : [];
  const openTask = (taskId: string) =>
    router.push({ pathname: '/teams/[teamId]/task/[taskId]', params: { teamId, taskId } });
  const goSegment = (path: '/teams/[teamId]/board' | '/teams/[teamId]/structure') =>
    router.replace({ pathname: path, params: { teamId } });

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      refreshControl={
        <RefreshControl
          refreshing={detail.isRefetching}
          onRefresh={() => {
            void detail.refetch();
            void board.refetch();
            void ledger.refetch();
          }}
        />
      }
    >
      <TeamScreenHeader team={teamId} segment="overview" />
      {detail.error ? <Row wrap row={errorRow(detail.error, 'teams.get')} /> : null}
      {detail.isPending ? <Skeleton rows={4} height={64} /> : null}
      {team ? (
        <View style={[styles.strip, fontScale >= 1.6 ? styles.stripColumn : null]}>
          {statusStrip(team, boardTasks, now).map((tile) => (
            <View
              key={tile.key}
              style={[styles.stripTile, fontScale >= 1.6 ? styles.stripTileFull : null]}
              accessible
            >
              <Text style={[type.small, styles.upper]}>{tile.label}</Text>
              <View style={styles.inline}>
                {tile.dot !== 'none' ? <StatusDot state={tile.dot} /> : null}
                <Text style={type.body}>{tile.value}</Text>
              </View>
              {tile.detail ? (
                <Text
                  style={[
                    type.mono,
                    tile.detail.startsWith('·') ? { color: color.textTertiary } : null,
                  ]}
                >
                  {tile.detail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {team && board.error ? (
        <Row wrap row={{ ...errorRow(board.error, 'getBoard'), glyph: '⚠', word: 'board' }} />
      ) : null}
      {team ? (
        <>
          <SectionTitle
            title={`Members ${team.members.length}`}
            action="Structure →"
            onAction={() => goSegment('/teams/[teamId]/structure')}
          />
          {board.isPending ? <Skeleton rows={3} height={52} /> : null}
          {team.members.map((m) => {
            const p = memberPresence(m, tasks ?? [], team.coordinator, reasons);
            return (
              <View key={m.personalityId} style={styles.member} accessible>
                <Mark personalityId={m.personalityId} size={32} />
                <View style={styles.flex}>
                  <View style={styles.inline}>
                    <Text style={type.body}>{m.personalityId}</Text>
                    {m.role === 'coordinator' ? (
                      <Text style={[type.small, styles.chip]}>coordinator</Text>
                    ) : null}
                  </View>
                  <View style={styles.inline}>
                    <StatusDot state={p.live ? 'running' : PRESENCE_DOT[p.state]} />
                    <Text style={[type.mono, styles.flex]} numberOfLines={1}>
                      {p.text}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </>
      ) : null}

      {attention.length > 0 ? (
        <>
          <SectionTitle
            title={`Needs attention ${attention.length}`}
            action="Board →"
            onAction={() => goSegment('/teams/[teamId]/board')}
          />
          {attention.map((t) => (
            <TaskTile
              key={t.id}
              task={t}
              reason={reasons.get(t.id)}
              meta={tileMeta(t)}
              onPress={() => openTask(t.id)}
            />
          ))}
        </>
      ) : null}

      <SectionTitle title="Supervisor ledger" />
      {ledger.error ? <Row wrap row={errorRow(ledger.error, 'teams.ledger')} /> : null}
      {ledger.isPending ? <Skeleton rows={3} height={40} /> : null}
      {ledger.data && ledger.data.items.length === 0 && team ? (
        ledgerEmptyLine(team) ? (
          <View style={styles.pad}>
            <CommandLine command={ledgerEmptyLine(team) ?? ''} />
          </View>
        ) : (
          <Text style={[type.small, styles.pad]}>Nothing yet.</Text>
        )
      ) : null}
      {ledger.data?.items.map((e) => (
        <Row
          key={e.id}
          row={ledgerRow(e)}
          onPress={e.taskId ? () => openTask(e.taskId ?? '') : undefined}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  upper: { textTransform: 'uppercase' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  strip: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, gap: 8 },
  stripColumn: { flexDirection: 'column' },
  stripTile: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 64,
    padding: 10,
    gap: 2,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.md,
  },
  stripTileFull: { flexBasis: 'auto' },
  member: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  chip: {
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.full,
    paddingHorizontal: 8,
  },
});
