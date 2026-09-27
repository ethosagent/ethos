import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useRpc } from '../../../../src/api/queries';
import { teamKeys, useKanbanSync, useLedger } from '../../../../src/api/teams';
import { Chip, ChipRow, useListBottomInset } from '../../../../src/components/agents/AgentParts';
import { MarkdownView } from '../../../../src/components/agents/MarkdownView';
import { SectionTitle, TeamScreenHeader } from '../../../../src/components/teams/TeamParts';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { ledgerRow } from '../../../../src/features/teams/overview';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

type Pane = 'memory' | 'activity';

/**
 * team-more (§6): the remaining panes in `TEAM_PANES` order that a phone key
 * can reach — Memory (`teams.memoryList/memoryRead`, read-only: `memoryWrite`
 * is cookie-only) and Activity (the full ledger). Documents is Phase 4, and
 * Channels needs `platforms.list`, which no bearer scope maps yet — both are
 * absent rather than disabled (§11a rule 2).
 */
export default function TeamMore() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const bottomInset = useListBottomInset();
  useKanbanSync(teamId);
  const queryClient = useQueryClient();
  const [pane, setPane] = useState<Pane>('memory');
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({
      queryKey: pane === 'memory' ? teamKeys.memory(teamId) : teamKeys.ledger(teamId),
    });
    setRefreshing(false);
  };
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <TeamScreenHeader team={teamId} segment="more" />
      <ChipRow>
        <Chip label="Memory" selected={pane === 'memory'} onPress={() => setPane('memory')} />
        <Chip label="Activity" selected={pane === 'activity'} onPress={() => setPane('activity')} />
      </ChipRow>
      {pane === 'memory' ? <MemoryPane team={teamId} /> : <ActivityPane team={teamId} />}
    </ScrollView>
  );
}

function MemoryPane({ team }: { team: string }) {
  const rpc = useRpc();
  const list = useQuery({
    queryKey: teamKeys.memory(team),
    queryFn: () => rpc.teams.memoryList({ team }),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const keys = list.data?.items.map((i) => i.key) ?? [];
  const key = picked ?? keys[0] ?? null;
  const topic = useQuery({
    queryKey: [...teamKeys.memory(team), key],
    queryFn: () => rpc.teams.memoryRead({ team, key: key ?? '' }),
    enabled: key !== null,
  });
  return (
    <View>
      {list.error ? <Row wrap row={errorRow(list.error, 'teams.memoryList')} /> : null}
      {list.isPending ? <Skeleton rows={3} height={28} /> : null}
      {list.data && keys.length === 0 ? (
        <Text style={[type.small, styles.pad]}>No team memory yet.</Text>
      ) : null}
      {keys.length > 0 ? (
        <ChipRow>
          {keys.map((k) => (
            <Chip key={k} label={`${k}.md`} selected={k === key} onPress={() => setPicked(k)} />
          ))}
        </ChipRow>
      ) : null}
      {topic.error ? <Row wrap row={errorRow(topic.error, 'teams.memoryRead')} /> : null}
      {key && topic.isPending ? <Skeleton rows={4} height={20} /> : null}
      {topic.data ? (
        <View style={styles.box}>
          <Text style={type.mono}>
            teams/{team}/memory/{topic.data.key}.md
          </Text>
          {topic.data.content.trim() ? (
            <MarkdownView value={topic.data.content} />
          ) : (
            <Text style={type.small}>Empty.</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function ActivityPane({ team }: { team: string }) {
  const router = useRouter();
  const ledger = useLedger(team, 200);
  return (
    <View>
      <SectionTitle title="Supervisor ledger" />
      {ledger.error ? <Row wrap row={errorRow(ledger.error, 'teams.ledger')} /> : null}
      {ledger.isPending ? <Skeleton rows={5} height={40} /> : null}
      {ledger.data && ledger.data.items.length === 0 ? (
        <Text style={[type.small, styles.pad]}>Nothing yet.</Text>
      ) : null}
      {ledger.data?.items.map((e) => (
        <Row
          key={e.id}
          row={ledgerRow(e)}
          onPress={
            e.taskId
              ? () =>
                  router.push({
                    pathname: '/teams/[teamId]/task/[taskId]',
                    params: { teamId: team, taskId: e.taskId ?? '' },
                  })
              : undefined
          }
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  box: {
    margin: 16,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.md,
  },
});
