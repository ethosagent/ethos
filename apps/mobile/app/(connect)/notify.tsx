import { Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRpc } from '../../src/api/queries';
import { Button } from '../../src/components/ui/Button';
import { RouteError } from '../../src/components/ui/RouteError';
import { Row } from '../../src/components/ui/Row';
import type { RowData } from '../../src/lib/row';
import { registerForPush } from '../../src/push/registration';
import { useConnection } from '../../src/state/connection';
import { color, type } from '../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * ob-notify (T4). Requesting the permission registers the device and — on a
 * grant — fires `push.test` immediately: the magical moment (an agent asking
 * on the lock screen, answered with a Face ID glance) happens in the first
 * minute rather than whenever an agent next reaches for a gated tool.
 */
export default function NotifyScreen() {
  const rpc = useRpc();
  const [row, setRow] = useState<RowData | null>(null);
  const [busy, setBusy] = useState(false);

  const enable = async (): Promise<void> => {
    setBusy(true);
    const result = await registerForPush(rpc);
    if (result.registered) {
      const test = await rpc.push.test({}).catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));
      setRow(
        test.ok
          ? { glyph: '✓', word: 'push', subject: 'Expo', result: 'registered · test sent' }
          : { glyph: '✗', word: 'push', subject: 'Expo', result: test.error },
      );
    } else {
      setRow({ glyph: '✗', word: 'push', subject: 'permission', result: result.reason });
    }
    setBusy(false);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Approvals as notifications' }} />
      <Text style={type.body}>
        When an agent needs your approval, Ethos will be able to ask on the lock screen.
      </Text>
      {row ? <Row wrap row={row} /> : null}
      <Button label="Enable notifications" filled disabled={busy} onPress={() => void enable()} />
      <Button
        label="Continue"
        disabled={busy}
        onPress={() => useConnection.getState().set({ onboarding: false })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase, padding: 16, gap: 16 },
});
