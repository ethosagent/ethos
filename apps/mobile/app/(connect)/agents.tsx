import { personalityAccent } from '@ethosagent/design-tokens';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../src/api/errors';
import { modelName, usePersonalities } from '../../src/api/queries';
import { Button } from '../../src/components/ui/Button';
import { Mark } from '../../src/components/ui/Mark';
import { RouteError } from '../../src/components/ui/RouteError';
import { Row } from '../../src/components/ui/Row';
import { Skeleton } from '../../src/components/ui/Skeleton';
import { useConnection } from '../../src/state/connection';
import { color, type } from '../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/** ob-agents — a mandatory pick, defaulting to the server's default agent, so
 *  Chat always has a personality on first open. Teams join this list in Phase 2. */
export default function AgentsScreen() {
  const router = useRouter();
  const list = usePersonalities();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? list.data?.defaultId ?? null;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Who is on this machine' }} />
      {list.isPending ? <Skeleton height={60} /> : null}
      {list.error ? <Row wrap row={errorRow(list.error, 'personalities.list')} /> : null}
      <FlatList
        data={list.data?.items ?? []}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: item.id === selected }}
            onPress={() => setPicked(item.id)}
            style={styles.item}
          >
            <Mark personalityId={item.id} size={30} />
            <View style={styles.flex}>
              <Text style={type.body}>{item.name}</Text>
              {modelName(item.model) ? (
                <Text style={type.mono}>{modelName(item.model)}</Text>
              ) : null}
            </View>
            {item.id === selected ? (
              <Text style={{ color: personalityAccent(item.id) }}>✓</Text>
            ) : null}
          </Pressable>
        )}
      />
      <View style={styles.footer}>
        <Button
          label="Continue"
          filled
          disabled={!selected}
          onPress={() => {
            useConnection.getState().set({ personalityId: selected });
            router.push('/notify');
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
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
  footer: { padding: 16 },
});
