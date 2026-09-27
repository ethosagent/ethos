import { useLocalSearchParams, useRouter } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { modelName, usePersonalities } from '../../../../src/api/queries';
import { useBoard, useKanbanSync, useTeamDetail } from '../../../../src/api/teams';
import { useListBottomInset } from '../../../../src/components/agents/AgentParts';
import {
  SectionTitle,
  StatusDot,
  TeamScreenHeader,
} from '../../../../src/components/teams/TeamParts';
import { Mark } from '../../../../src/components/ui/Mark';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import {
  buildStructure,
  LEGEND,
  type StructureNode,
} from '../../../../src/features/teams/structure';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * team-structure (§6): the web canvas as a tree — the coordinator on top with
 * a `lead` marker, one edge, members beneath (mark, name, `capability · model`
 * in mono, liveness dot); the legend; then Shared rows. Nodes are bordered
 * containers from primitives (D8).
 */
export default function TeamStructure() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const router = useRouter();
  const bottomInset = useListBottomInset();
  useKanbanSync(teamId);
  const detail = useTeamDetail(teamId);
  const board = useBoard(teamId);
  const personalities = usePersonalities();
  const team = detail.data;
  const tree = team
    ? buildStructure(team, board.data?.board.tasks ?? [], (id) =>
        modelName(personalities.data?.items.find((p) => p.id === id)?.model),
      )
    : null;
  const more = () => router.replace({ pathname: '/teams/[teamId]/more', params: { teamId } });

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
          }}
        />
      }
    >
      <TeamScreenHeader team={teamId} segment="structure" />
      {detail.error ? <Row wrap row={errorRow(detail.error, 'teams.get')} /> : null}
      {detail.isPending ? <Skeleton rows={4} height={60} /> : null}
      {tree ? (
        <View style={styles.tree}>
          {tree.lead ? <Node node={tree.lead} /> : null}
          {tree.lead && tree.members.length > 0 ? <View style={styles.edge} /> : null}
          <View style={tree.lead ? styles.children : null}>
            {tree.members.map((n) => (
              <Node key={n.personalityId} node={n} />
            ))}
          </View>
          <View style={styles.legend}>
            {LEGEND.map((l) => (
              <View key={l} style={styles.inline}>
                <StatusDot state={l} />
                <Text style={type.small}>{l}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {team ? (
        <>
          <SectionTitle title="Shared" />
          <Row
            row={{
              glyph: '·',
              word: 'memory',
              subject: `${team.memoryTopics.length} topics`,
              result: team.memoryTopics.join(', ') || 'none yet',
            }}
            onPress={more}
          />
          <Row
            row={{
              glyph: '·',
              word: 'documents',
              subject: `~/.ethos/teams/${team.name}`,
              result: 'open on the web',
            }}
          />
          <Row
            row={{
              glyph: '·',
              word: 'channels',
              subject: `${team.channels.length} bound`,
              result: team.channels.map((c) => `${c.platform} ${c.botKey}`).join(', ') || 'none',
            }}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

function Node({ node }: { node: StructureNode }) {
  return (
    <View
      style={styles.node}
      accessible
      accessibilityLabel={`${node.personalityId}${node.lead ? ', lead' : ''}, ${node.line}, ${node.liveness}`}
    >
      <Mark personalityId={node.personalityId} size={32} />
      <View style={styles.flex}>
        <View style={styles.inline}>
          <Text style={type.body}>{node.personalityId}</Text>
          {node.lead ? <Text style={[type.small, styles.lead]}>lead</Text> : null}
        </View>
        <Text style={type.mono} numberOfLines={2}>
          {node.line}
        </Text>
      </View>
      <View style={styles.inline}>
        <StatusDot state={node.liveness} />
        <Text style={type.small}>{node.liveness}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tree: { paddingHorizontal: 16, paddingTop: 8 },
  edge: { width: 1, height: 16, marginLeft: 31, backgroundColor: color.borderStrong },
  children: {
    marginLeft: 31,
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: color.borderStrong,
  },
  node: {
    minHeight: 60,
    padding: 10,
    marginVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.md,
    backgroundColor: color.bgElevated,
  },
  lead: {
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.full,
    paddingHorizontal: 8,
  },
  legend: { flexDirection: 'row', gap: 16, paddingVertical: 12, flexWrap: 'wrap' },
});
