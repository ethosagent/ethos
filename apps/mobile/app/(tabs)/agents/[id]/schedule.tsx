import { useQueries, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { usePersonalities, useRpc } from '../../../../src/api/queries';
import {
  AgentScreenHeader,
  SectionHeader,
  useListBottomInset,
} from '../../../../src/components/agents/AgentParts';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { jobsFor, recentFirings } from '../../../../src/features/agents/schedule';
import { clock } from '../../../../src/lib/row';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

const RUNS_PER_JOB = 5;

function when(iso: string | null): string {
  return iso ? clock(Date.parse(iso)) : '—';
}

/**
 * agent-schedule (§5): this agent's cron jobs as cards (the second Card
 * exemption) and their recent firings as feedback rows. Read-only on a
 * phone: every cron mutation — create included — is cookie-only, so no
 * `+ New job`, pause, resume or run-now is rendered (§11a rule 2).
 */
export default function AgentSchedule() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const rpc = useRpc();
  const bottomInset = useListBottomInset();
  const agents = usePersonalities();
  const name = agents.data?.items.find((p) => p.id === id)?.name ?? id;
  const list = useQuery({ queryKey: ['cron', 'list'], queryFn: () => rpc.cron.list() });
  const jobs = jobsFor(list.data?.jobs ?? [], id);
  const histories = useQueries({
    queries: jobs.map((job) => ({
      queryKey: ['cron', 'history', job.id],
      queryFn: () => rpc.cron.history({ id: job.id, limit: RUNS_PER_JOB }),
    })),
  });
  const historyError = histories.find((h) => h.error)?.error;
  const firings = recentFirings(
    jobs.map((job, i) => ({ job, runs: histories[i]?.data?.runs ?? [] })),
  );

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      refreshControl={
        <RefreshControl
          refreshing={list.isRefetching}
          onRefresh={() => {
            void list.refetch();
            for (const h of histories) void h.refetch();
          }}
        />
      }
    >
      <AgentScreenHeader id={id} segment="schedule" />
      {list.error ? <Row wrap row={errorRow(list.error, 'cron.list')} /> : null}
      {list.isPending ? <Skeleton rows={3} height={64} /> : null}
      {list.data && jobs.length === 0 ? (
        <Text style={[type.small, styles.pad]}>No jobs for {name}.</Text>
      ) : null}
      {jobs.map((job) => (
        <View
          key={job.id}
          style={styles.card}
          accessible
          accessibilityLabel={`${job.name}, ${job.schedule}, ${job.status}`}
        >
          <View style={styles.cardTop}>
            <Text style={[type.body, styles.flex]} numberOfLines={1}>
              {job.name}
            </Text>
            <Text style={type.mono}>{job.status}</Text>
          </View>
          <Text style={type.mono}>{job.schedule}</Text>
          <Text style={type.small} numberOfLines={1}>
            {job.prompt.split('\n')[0]}
          </Text>
          <Text style={[type.mono, { color: color.textTertiary }]}>
            {`last ${when(job.lastRunAt)} · next ${when(job.nextRunAt)}`}
          </Text>
        </View>
      ))}
      {jobs.length > 0 ? <SectionHeader>Recent firings</SectionHeader> : null}
      {historyError ? (
        <Row wrap row={{ ...errorRow(historyError, 'cron.history'), word: 'history' }} />
      ) : null}
      {jobs.length > 0 &&
      !historyError &&
      histories.every((h) => h.data) &&
      firings.length === 0 ? (
        <Text style={[type.small, styles.pad]}>No firings yet.</Text>
      ) : null}
      {firings.map((f) => (
        <Row key={f.key} row={f.row} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  card: {
    minHeight: 64,
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 12,
    gap: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    backgroundColor: color.bgElevated,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
