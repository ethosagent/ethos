import { remoteHost } from '@ethosagent/sdk';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../../src/api/errors';
import { modelName, usePersonalities, useTeams } from '../../../src/api/queries';
import {
  AgentRow,
  SectionHeader,
  useListBottomInset,
} from '../../../src/components/agents/AgentParts';
import { Button } from '../../../src/components/ui/Button';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import { Skeleton } from '../../../src/components/ui/Skeleton';
import { type AgentRowView, groupAgents } from '../../../src/features/agents/grouping';
import { useConnection } from '../../../src/state/connection';
import { color, type } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

type Personality = NonNullable<ReturnType<typeof usePersonalities>['data']>['items'][number];

function NewAgentHeaderButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New agent"
      onPress={onPress}
      style={styles.headerButton}
    >
      <Text style={[type.h4, { color: color.chrome }]}>+</Text>
    </Pressable>
  );
}

/**
 * agents (§5): large title, `<host> · N personalities`, search; Independent,
 * In teams and Built-in helpers as rows (D8). A failed `teams.list` puts
 * everyone under Independent with a `⚠ teams` row above (§11a PARTIAL).
 */
export default function AgentsScreen() {
  const router = useRouter();
  const bottomInset = useListBottomInset();
  const { url, online } = useConnection();
  const host = (url && remoteHost(url)) ?? '—';
  const agents = usePersonalities();
  const teams = useTeams();
  const [query, setQuery] = useState('');
  const items = agents.data?.items ?? [];
  const groups = groupAgents(items, teams.data?.items ?? (teams.error ? null : []), query);
  const open = (id: string) => router.push({ pathname: '/agents/[id]', params: { id } });

  const sections = [
    { title: `Independent ${groups.independent.length}`, data: groups.independent },
    { title: `In teams ${groups.inTeams.length}`, data: groups.inTeams },
    { title: 'Built-in helpers', data: groups.helpers },
  ].filter((s) => s.data.length > 0);

  const subtitle = [host, agents.data ? `${items.length} personalities` : null]
    .concat(online ? [] : ['offline'])
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: 'Agents',
          headerLargeTitle: true,
          headerRight: () => <NewAgentHeaderButton onPress={() => router.push('/agents/new')} />,
          headerSearchBarOptions: {
            placeholder: 'Search agents',
            hideWhenScrolling: true,
            onChangeText: (e) => setQuery(e.nativeEvent.text),
          },
        }}
      />
      <SectionList<AgentRowView<Personality>, { title: string }>
        sections={sections}
        keyExtractor={(r) => r.personality.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: bottomInset }}
        refreshing={agents.isRefetching || teams.isRefetching}
        onRefresh={() => {
          void agents.refetch();
          void teams.refetch();
        }}
        ListHeaderComponent={
          <View>
            <Text style={[type.mono, styles.subtitle]}>{subtitle}</Text>
            {agents.error ? <Row wrap row={errorRow(agents.error, 'personalities.list')} /> : null}
            {agents.isPending ? <Skeleton height={60} /> : null}
            {teams.error && agents.data ? (
              <Row
                wrap
                row={{ ...errorRow(teams.error, 'teams.list'), glyph: '⚠', word: 'teams' }}
              />
            ) : null}
            {agents.data && items.length === 0 ? (
              <View style={styles.empty}>
                <Text style={type.body}>No personalities on {host}.</Text>
                <Button label="New agent" onPress={() => router.push('/agents/new')} />
              </View>
            ) : null}
            {agents.data && items.length > 0 && sections.length === 0 ? (
              <Text style={[type.small, styles.subtitle]}>Nothing matches.</Text>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => <SectionHeader>{section.title}</SectionHeader>}
        renderItem={({ item }) => (
          <AgentRow
            personalityId={item.personality.id}
            title={item.personality.name}
            subtitle={
              item.teamLine ?? item.personality.description ?? modelName(item.personality.model)
            }
            mono={!!item.teamLine}
            onPress={() => open(item.personality.id)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  subtitle: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  empty: { padding: 16, gap: 12, alignItems: 'flex-start' },
  headerButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
