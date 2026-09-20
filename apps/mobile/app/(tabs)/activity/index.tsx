import {
  type ActivityKind,
  type ActivityRow,
  convertHistoryItem,
  convertSseEvent,
  mergeRows,
} from '@ethosagent/chat-state';
import { useQuery } from '@tanstack/react-query';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';
import { activityOpener, streams } from '../../../src/api/client';
import { errorRow } from '../../../src/api/errors';
import { usePersonalities, useRpc } from '../../../src/api/queries';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import { Skeleton } from '../../../src/components/ui/Skeleton';
import { type ActivityChip, chipKey, historyInput } from '../../../src/features/activity/chips';
import { NEEDS_YOU_KEY, needsYouCount } from '../../../src/features/activity/needs-you';
import { clock, type Glyph, type RowData } from '../../../src/lib/row';
import { useChatStore } from '../../../src/state/chat-store';
import { useConnection } from '../../../src/state/connection';
import { color, radius, type } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

const GLYPH: Record<ActivityKind, Glyph> = {
  tool_start: '·',
  tool_end: '✓',
  done: '✓',
  error: '✗',
  approval: '⚠',
  cron: '·',
  notice: '·',
};

interface Item {
  key: string;
  row: RowData;
  sessionId: string | null;
}

/**
 * activity (§7): "Needs you N" pinned, then the server's history, newest first.
 * Chips change the server query. Rows go to the thing — the session's chat.
 */
export default function ActivityScreen() {
  const rpc = useRpc();
  const router = useRouter();
  const agents = usePersonalities();
  const [chip, setChip] = useState<ActivityChip>({ kind: 'all' });
  const feedPersonalityId = chip.kind === 'agent' ? chip.personalityId : null;
  const history = useQuery({
    queryKey: ['activity', chipKey(chip)],
    queryFn: () => rpc.activity.history(historyInput(chip)),
  });
  const pending = useQuery({ queryKey: NEEDS_YOU_KEY, queryFn: () => rpc.tools.listPending({}) });
  const questions = useChatStore((s) => s.chat.pendingClarifies);
  const openSession = useChatStore((s) => s.sessionId);
  const refetchPending = pending.refetch;
  useFocusEffect(
    useCallback(() => {
      void refetchPending();
    }, [refetchPending]),
  );

  // History (durable) + live `/sse/activity` rows merged into one keyed map,
  // same reducer the web Activity page uses (`mergeRows` ranks a finished row
  // over a started one, never the reverse). Reset on chip switch — a chip
  // scopes both the history query and the feed's `?personalityId=`, so rows
  // from the previous scope don't linger into the new one.
  const [rows, setRows] = useState<Map<string, ActivityRow>>(() => new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on feedPersonalityId only — the effect body doesn't read it, it's the reset trigger
  useEffect(() => {
    setRows(new Map());
  }, [feedPersonalityId]);
  useEffect(() => {
    const items = history.data?.items;
    if (!items) return;
    setRows((prev) => mergeRows(prev, items.map(convertHistoryItem)));
  }, [history.data]);
  useFocusEffect(
    useCallback(() => {
      const { url, key } = useConnection.getState();
      if (!url || !key) return;
      const path = feedPersonalityId
        ? `/sse/activity?personalityId=${encodeURIComponent(feedPersonalityId)}`
        : '/sse/activity';
      streams.openFeed(
        path,
        activityOpener(url, key, {
          onEvent: (envelope, seq) => {
            const row = convertSseEvent(envelope.event, {
              sessionId: envelope.sessionId,
              personalityId: envelope.personalityId,
              seq,
              timestamp: Date.now(),
            });
            if (row) setRows((prev) => mergeRows(prev, [row]));
          },
        }),
      );
      return () => streams.closeFeed(path);
    }, [feedPersonalityId]),
  );

  const needsYou: Item[] = [
    ...(pending.data ?? []).map((a) => ({
      key: `a:${a.approvalId}`,
      sessionId: a.sessionId,
      row: {
        glyph: '⚠' as const,
        word: 'approval',
        subject: a.toolName,
        result: a.reason ?? 'wants to run a tool',
      },
    })),
    ...questions.map((q) => ({
      key: `q:${q.requestId}`,
      sessionId: openSession,
      row: { glyph: '⚠' as const, word: 'question', subject: 'clarify', result: q.question },
    })),
  ];
  const recent: Item[] = [...rows.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((r) => ({
      key: r.key,
      sessionId: r.sessionId,
      row: {
        glyph: GLYPH[r.kind],
        word: r.label,
        subject: r.personalityId ?? '—',
        result: r.summary,
        time: clock(r.timestamp),
      },
    }));
  const count = needsYouCount(pending.data ?? [], questions.length);
  const sections = [
    ...(count > 0 ? [{ title: `Needs you ${count}`, data: needsYou }] : []),
    { title: 'Recent', data: recent },
  ];
  const chips: ActivityChip[] = [
    { kind: 'all' },
    ...(agents.data?.items ?? []).map((p) => ({ kind: 'agent' as const, personalityId: p.id })),
  ];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Activity', headerLargeTitle: true }} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {chips.map((c) => {
          const selected = chipKey(c) === chipKey(chip);
          return (
            <Pressable
              key={chipKey(c)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setChip(c)}
              style={[styles.chip, selected ? styles.chipOn : null]}
            >
              <Text style={[type.small, selected ? { color: color.textPrimary } : null]}>
                {c.kind === 'agent' ? c.personalityId : 'All agents'}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {history.error ? <Row wrap row={errorRow(history.error, 'activity.history')} /> : null}
      {pending.error ? <Row wrap row={errorRow(pending.error, 'tools.listPending')} /> : null}
      {history.isPending ? <Skeleton height={40} /> : null}
      {history.isSuccess && recent.length === 0 && count === 0 ? (
        <Text style={[type.small, styles.header]}>
          Nothing yet. Actions appear here as they happen.
        </Text>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.key}
        refreshing={history.isRefetching}
        onRefresh={() => {
          void history.refetch();
          void pending.refetch();
        }}
        renderSectionHeader={({ section }) => (
          <Text style={[type.small, styles.header]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Row
            row={item.row}
            onPress={
              item.sessionId
                ? () =>
                    router.navigate({
                      pathname: '/chat/[sessionId]',
                      params: { sessionId: item.sessionId ?? '' },
                    })
                : undefined
            }
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  chips: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  chip: {
    height: 28,
    paddingHorizontal: 11,
    justifyContent: 'center',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    backgroundColor: color.bgElevated,
  },
  chipOn: { backgroundColor: color.bgOverlay, borderColor: color.borderStrong },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
});
