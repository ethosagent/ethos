import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useRpc } from '../../../../src/api/queries';
import {
  AgentScreenHeader,
  SectionHeader,
  Segmented,
  useListBottomInset,
} from '../../../../src/components/agents/AgentParts';
import { MarkdownView } from '../../../../src/components/agents/MarkdownView';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { fileLine } from '../../../../src/features/agents/memory-file';
import { pendingKey, pendingRow } from '../../../../src/features/agents/pending-memory';
import { clock } from '../../../../src/lib/row';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

type Pane = 'memory' | 'user' | 'search';
const PANES: ReadonlyArray<{ key: Pane; label: string }> = [
  { key: 'memory', label: 'MEMORY.md' },
  { key: 'user', label: 'USER.md' },
  { key: 'search', label: 'Search' },
];

/**
 * agent-memory (§5): MEMORY.md · USER.md · Search. The markdown renders with
 * the kit's type roles; parked writes (`memory.pendingList`) are `⚠ proposed`
 * rows that open the review sheet. Memory is written by the agent, so an empty
 * file has no verb (§11a). Search is FTS over this agent's session history.
 */
export default function AgentMemory() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const rpc = useRpc();
  const router = useRouter();
  const bottomInset = useListBottomInset();
  const [pane, setPane] = useState<Pane>('memory');
  const [q, setQ] = useState('');
  const store = pane === 'search' ? null : pane;
  const file = useQuery({
    queryKey: ['memory', 'get', id, store],
    queryFn: () => rpc.memory.get({ store: store ?? 'memory', personalityId: id }),
    enabled: store !== null,
  });
  const pending = useQuery({
    queryKey: pendingKey(id),
    queryFn: () => rpc.memory.pendingList({ personalityId: id }),
  });
  const query = q.trim();
  const search = useQuery({
    queryKey: ['sessions', 'search', id, query],
    queryFn: () => rpc.sessions.list({ q: query, personalityId: id, limit: 20 }),
    enabled: pane === 'search' && query.length > 0,
  });
  const items = pending.data?.pending ?? [];

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={file.isRefetching || pending.isRefetching}
          onRefresh={() => {
            void file.refetch();
            void pending.refetch();
          }}
        />
      }
    >
      <AgentScreenHeader id={id} segment="memory" />
      <View style={styles.pad}>
        <Segmented segments={PANES} value={pane} onChange={setPane} />
      </View>

      {pane === 'search' ? (
        <View>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search this agent's sessions"
            placeholderTextColor={color.textTertiary}
            returnKeyType="search"
            autoCorrect={false}
            accessibilityLabel="Search sessions"
            style={[type.body, styles.input]}
          />
          {search.error ? <Row wrap row={errorRow(search.error, 'sessions.list')} /> : null}
          {search.isFetching && !search.data ? <Skeleton rows={3} height={52} /> : null}
          {search.data?.items.length === 0 ? (
            <Text style={[type.small, styles.pad]}>Nothing matches.</Text>
          ) : null}
          {search.data?.items.map((s) => (
            <Row
              key={s.id}
              row={{
                glyph: '·',
                word: 'session',
                subject: s.title ?? 'Untitled',
                time: clock(Date.parse(s.updatedAt)),
              }}
              onPress={() =>
                router.navigate({ pathname: '/chat/[sessionId]', params: { sessionId: s.id } })
              }
            />
          ))}
        </View>
      ) : (
        <View>
          {file.data ? (
            <Text style={[type.mono, styles.pad]} numberOfLines={2} ellipsizeMode="middle">
              {fileLine(file.data.file)}
            </Text>
          ) : null}
          {file.error ? <Row wrap row={errorRow(file.error, 'memory.get')} /> : null}
          <View style={styles.box}>
            {file.isPending ? <Skeleton rows={4} height={26} /> : null}
            {file.data && file.data.file.content.trim() === '' ? (
              <Text style={type.small}>Empty.</Text>
            ) : null}
            {file.data && file.data.file.content.trim() !== '' ? (
              <MarkdownView value={file.data.file.content} />
            ) : null}
          </View>
        </View>
      )}

      {pending.error ? (
        <Row
          wrap
          row={{ ...errorRow(pending.error, 'memory.pendingList'), glyph: '⚠', word: 'pending' }}
        />
      ) : null}
      {items.length > 0 ? (
        <View>
          <SectionHeader>{`Pending memory writes ${items.length}`}</SectionHeader>
          {items.map((p) => (
            <Row
              key={p.id}
              row={pendingRow(p)}
              onPress={() =>
                router.push({
                  pathname: '/agents/[id]/memory-approve',
                  params: { id, pendingId: p.id },
                })
              }
            />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  box: {
    marginHorizontal: 16,
    marginVertical: 8,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderSubtle,
  },
  input: {
    minHeight: 44,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    color: color.textPrimary,
  },
});
