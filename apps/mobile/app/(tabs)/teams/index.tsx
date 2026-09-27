import { remoteHost } from '@ethosagent/sdk';
import type { TeamSummary } from '@ethosagent/web-contracts';
import { Stack, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../../src/api/errors';
import { useTeams } from '../../../src/api/queries';
import { useListBottomInset } from '../../../src/components/agents/AgentParts';
import {
  CommandLine,
  SectionTitle,
  TaskTile,
  TeamRing,
} from '../../../src/components/teams/TeamParts';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import { Skeleton } from '../../../src/components/ui/Skeleton';
import {
  attentionTiles,
  teamRowSubtitle,
  teamsSubtitle,
} from '../../../src/features/teams/teams-list';
import { useConnection } from '../../../src/state/connection';
import { color, type } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * teams (§6): large title, `N running · M stopped`, one row per team with its
 * segmented ring, then Attention across teams — all one `teams.list` (S11).
 * No `+`: team creation stays on the web (D12), and a control that cannot
 * work is not rendered (§11a rule 2).
 */
export default function TeamsScreen() {
  const router = useRouter();
  const bottomInset = useListBottomInset();
  const { url, online } = useConnection();
  const host = (url && remoteHost(url)) ?? '—';
  const teams = useTeams();
  const items: TeamSummary[] = teams.data?.items ?? [];
  const tiles = attentionTiles(items);
  const subtitle = [teams.data ? teamsSubtitle(items) : host]
    .concat(online ? [] : ['offline'])
    .join(' · ');
  const openTeam = (teamId: string) =>
    router.push({ pathname: '/teams/[teamId]/overview', params: { teamId } });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Teams', headerLargeTitle: true }} />
      <FlatList
        data={items}
        keyExtractor={(t) => t.name}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: bottomInset }}
        refreshing={teams.isRefetching}
        onRefresh={() => void teams.refetch()}
        ListHeaderComponent={
          <View>
            <Text style={[type.mono, styles.subtitle]}>{subtitle}</Text>
            {teams.error ? <Row wrap row={errorRow(teams.error, 'teams.list')} /> : null}
            {teams.isPending ? <Skeleton rows={3} height={60} /> : null}
            {teams.data && items.length === 0 ? (
              <View style={styles.empty}>
                <TeamRing team="none" members={[]} size={40} />
                <Text style={type.body}>No teams on {host}.</Text>
                <Text style={type.small}>Create one on the web, or run</Text>
                <CommandLine command="ethos team create <name>" />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${teamRowSubtitle(item)}`}
            onPress={() => openTeam(item.name)}
            style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
          >
            <TeamRing team={item.name} members={item.members.map((m) => m.personalityId)} />
            <View style={styles.itemText}>
              <Text style={type.body} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={type.mono} numberOfLines={2}>
                {teamRowSubtitle(item)}
              </Text>
            </View>
          </Pressable>
        )}
        ListFooterComponent={
          tiles && tiles.length > 0 ? (
            <View>
              <SectionTitle title="Attention across teams" />
              {tiles.map(({ team, task }) => (
                <TaskTile
                  key={`${team}:${task.id}`}
                  task={task}
                  team={team}
                  onPress={() =>
                    router.push({
                      pathname: '/teams/[teamId]/task/[taskId]',
                      params: { teamId: team, taskId: task.id },
                    })
                  }
                />
              ))}
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  subtitle: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  empty: { padding: 16, gap: 10, alignItems: 'flex-start' },
  item: {
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  itemText: { flex: 1, gap: 2 },
  pressed: { backgroundColor: color.bgOverlay },
});
