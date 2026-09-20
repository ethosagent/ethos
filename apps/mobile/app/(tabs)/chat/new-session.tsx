import { useQuery } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorRow } from '../../../src/api/errors';
import { modelName, usePersonalities, useRpc } from '../../../src/api/queries';
import { Mark } from '../../../src/components/ui/Mark';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import { Skeleton } from '../../../src/components/ui/Skeleton';
import { tabBarBottomInset } from '../../../src/lib/tab-bar-inset';
import { color, TAB_BAR_PILL_HEIGHT, type } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/** newsession-pick (D5) — a pushed screen, not a sheet. The Teams section
 *  (a row opens the coordinator's chat) joins in Phase 2. */
export default function NewSession() {
  const router = useRouter();
  const rpc = useRpc();
  const insets = useSafeAreaInsets();
  const bottomInset = tabBarBottomInset({
    tabBarHeight: TAB_BAR_PILL_HEIGHT,
    safeAreaBottom: insets.bottom,
    keyboardVisible: false,
  });
  const agents = usePersonalities();
  const recent = useQuery({
    queryKey: ['sessions', 'recent'],
    queryFn: () => rpc.sessions.list({ limit: 10 }),
  });
  const error = agents.error ?? recent.error;
  const sections = [
    {
      title: 'Independent',
      data: (agents.data?.items ?? []).map((p) => ({
        key: `p:${p.id}`,
        personalityId: p.id,
        title: p.name,
        subtitle: modelName(p.model),
        go: () =>
          router.replace({
            pathname: '/chat/[sessionId]',
            params: { sessionId: 'new', personalityId: p.id },
          }),
      })),
    },
    {
      title: 'Recent',
      data: (recent.data?.items ?? []).map((s) => ({
        key: `s:${s.id}`,
        personalityId: s.personalityId ?? 'ethos',
        title: s.title ?? 'Untitled',
        subtitle: s.personalityId,
        go: () => router.replace({ pathname: '/chat/[sessionId]', params: { sessionId: s.id } }),
      })),
    },
  ];
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'New session' }} />
      {error ? <Row wrap row={errorRow(error, 'personalities.list')} /> : null}
      {agents.isPending ? <Skeleton height={60} /> : null}
      <SectionList
        sections={sections}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        renderSectionHeader={({ section }) => (
          <Text style={[type.small, styles.header]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={item.go}
            style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
          >
            <Mark personalityId={item.personalityId} size={30} />
            <View style={styles.flex}>
              <Text style={type.body} numberOfLines={1}>
                {item.title}
              </Text>
              {item.subtitle ? <Text style={type.mono}>{item.subtitle}</Text> : null}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, textTransform: 'uppercase' },
  item: {
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.borderSubtle,
  },
  pressed: { backgroundColor: color.bgOverlay },
});
