import type { Session } from '@ethosagent/web-contracts';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorRow } from '../../../src/api/errors';
import { useRpc } from '../../../src/api/queries';
import { Button } from '../../../src/components/ui/Button';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import { Skeleton } from '../../../src/components/ui/Skeleton';
import { runSessionVerb, type SessionVerb } from '../../../src/features/chat/session-verbs';
import { clock, type RowData } from '../../../src/lib/row';
import { tabBarBottomInset } from '../../../src/lib/tab-bar-inset';
import { color, radius, TAB_BAR_PILL_HEIGHT, type } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

const VERBS: Array<{ verb: SessionVerb; label: string }> = [
  { verb: 'rename', label: 'Rename' },
  { verb: 'fork', label: 'Fork' },
  { verb: 'share', label: 'Share transcript…' },
  { verb: 'delete', label: 'Delete' },
];

function NewSessionHeaderButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New session"
      onPress={onPress}
      style={styles.headerButton}
    >
      <Text style={[type.h4, { color: color.chrome }]}>+</Text>
    </Pressable>
  );
}

/** sessions · session-actions (§4). Long-press opens the verbs as a native
 *  action sheet; Delete alone is destructive. */
export default function SessionsScreen() {
  const router = useRouter();
  const rpc = useRpc();
  const queries = useQueryClient();
  const { showActionSheetWithOptions } = useActionSheet();
  const insets = useSafeAreaInsets();
  const bottomInset = tabBarBottomInset({
    tabBarHeight: TAB_BAR_PILL_HEIGHT,
    safeAreaBottom: insets.bottom,
    keyboardVisible: false,
  });
  const list = useQuery({
    queryKey: ['sessions', 'list'],
    queryFn: () => rpc.sessions.list({ limit: 50 }),
  });
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [failure, setFailure] = useState<RowData | null>(null);

  const run = async (verb: SessionVerb, session: Session, title?: string) => {
    setFailure(null);
    try {
      const forked = await runSessionVerb(rpc.sessions, verb, {
        id: session.id,
        title,
        share: (message, filename) => Share.share({ message, title: filename }),
      });
      await queries.invalidateQueries({ queryKey: ['sessions'] });
      if (forked) router.replace({ pathname: '/chat/[sessionId]', params: { sessionId: forked } });
    } catch (err) {
      setFailure(errorRow(err, verb));
    }
  };

  const actions = (session: Session) =>
    showActionSheetWithOptions(
      {
        title: session.title ?? 'Untitled',
        options: [...VERBS.map((v) => v.label), 'Cancel'],
        destructiveButtonIndex: 3,
        cancelButtonIndex: 4,
      },
      (i) => {
        const verb = i === undefined ? undefined : VERBS[i]?.verb;
        if (verb === 'rename') setRenaming({ id: session.id, title: session.title ?? '' });
        else if (verb) void run(verb, session);
      },
    );

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: 'Sessions',
          headerRight: () => (
            <NewSessionHeaderButton onPress={() => router.push('/chat/new-session')} />
          ),
        }}
      />
      {failure ? <Row wrap row={failure} /> : null}
      {list.error ? <Row wrap row={errorRow(list.error, 'sessions.list')} /> : null}
      {list.isPending ? <Skeleton height={52} /> : null}
      {list.data?.items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={type.body}>No sessions yet.</Text>
          <Button label="New session" onPress={() => router.replace('/chat/new-session')} />
        </View>
      ) : null}
      <FlatList
        data={list.data?.items ?? []}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        refreshing={list.isRefetching}
        onRefresh={() => void list.refetch()}
        renderItem={({ item }) =>
          renaming?.id === item.id ? (
            <TextInput
              autoFocus
              value={renaming.title}
              onChangeText={(title) => setRenaming({ id: item.id, title })}
              onSubmitEditing={() => {
                void run('rename', item, renaming.title);
                setRenaming(null);
              }}
              onBlur={() => setRenaming(null)}
              returnKeyType="done"
              style={[type.body, styles.rename]}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Long-press for Rename, Fork, Share and Delete"
              onPress={() =>
                router.replace({ pathname: '/chat/[sessionId]', params: { sessionId: item.id } })
              }
              onLongPress={() => actions(item)}
              style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
            >
              <Text style={type.body} numberOfLines={1}>
                {item.title ?? 'Untitled'}
              </Text>
              <Text style={type.mono} numberOfLines={1}>
                {[item.personalityId, clock(Date.parse(item.updatedAt))]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Pressable>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  empty: { padding: 16, gap: 12, alignItems: 'flex-start' },
  headerButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  item: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: color.borderSubtle,
  },
  pressed: { backgroundColor: color.bgOverlay },
  rename: {
    minHeight: 52,
    marginHorizontal: 16,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
  },
});
