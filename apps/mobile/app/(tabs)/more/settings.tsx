import { remoteHost } from '@ethosagent/sdk';
import type { PushCategories } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorRow } from '../../../src/api/errors';
import { useRpc } from '../../../src/api/queries';
import { probeHealth, refusals } from '../../../src/auth/probes';
import { Button } from '../../../src/components/ui/Button';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import type { RowData } from '../../../src/lib/row';
import { tabBarBottomInset } from '../../../src/lib/tab-bar-inset';
import { registerForPush, unregisterCurrentPush } from '../../../src/push/registration';
import { useConnection } from '../../../src/state/connection';
import { usePushPrefs } from '../../../src/state/push-prefs';
import { color, TAB_BAR_PILL_HEIGHT, type } from '../../../src/theme/tokens';

const CATEGORY_LABELS: Array<{ key: keyof PushCategories; label: string }> = [
  { key: 'approvals', label: 'Tool approvals' },
  { key: 'clarify', label: 'Agent questions' },
  { key: 'cronFailures', label: 'Cron failures' },
  { key: 'teamAttention', label: 'Team attention' },
  { key: 'runFinished', label: 'Run finished' },
];

export { RouteError as ErrorBoundary };

/**
 * settings (§8): the server and key as the server reports them (`/healthz`,
 * `meta.whoami`), the scope check on demand, diagnostics, and Disconnect —
 * which forgets the key here; the key itself is revoked on the server.
 */
export default function SettingsScreen() {
  const rpc = useRpc();
  const { url, disconnect } = useConnection();
  const insets = useSafeAreaInsets();
  const bottomInset = tabBarBottomInset({
    tabBarHeight: TAB_BAR_PILL_HEIGHT,
    safeAreaBottom: insets.bottom,
    keyboardVisible: false,
  });
  const host = (url && remoteHost(url)) ?? '—';
  const health = useQuery({ queryKey: ['healthz', url], queryFn: () => probeHealth(url ?? '') });
  const whoami = useQuery({ queryKey: ['whoami'], queryFn: () => rpc.meta.whoami() });
  const [scopeRows, setScopeRows] = useState<RowData[] | null>(null);
  const categories = usePushPrefs((s) => s.categories);
  const setCategories = usePushPrefs((s) => s.set);
  const [pushRow, setPushRow] = useState<RowData | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const key = whoami.data?.authMethod === 'bearer' ? whoami.data.key : null;

  const applyCategories = async (next: PushCategories): Promise<void> => {
    setCategories(next);
    setPushBusy(true);
    const result = await registerForPush(rpc, next);
    setPushRow(
      result.registered
        ? { glyph: '✓', word: 'push', subject: 'Expo', result: 'registered' }
        : { glyph: '✗', word: 'push', subject: 'Expo', result: result.reason },
    );
    setPushBusy(false);
  };
  const version = health.data?.version ?? null;
  const kv: Array<[string, string]> = [
    ['url', url ?? '—'],
    ['version', health.isPending ? '…' : (version ?? 'unknown')],
    ['key', key ? `${key.name} · ${key.prefix}…` : '…'],
    ['scopes', key ? key.scopes.join(', ') || 'none' : '…'],
    ['created', key?.createdAt ?? '…'],
    ['last used', key ? (key.lastUsed ?? 'never') : '…'],
  ];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.body, { paddingBottom: 32 + bottomInset }]}
    >
      <Stack.Screen options={{ title: 'Settings' }} />
      <Text style={[type.small, styles.header]}>Server</Text>
      {kv.map(([k, v]) => (
        <View key={k} style={styles.kv}>
          <Text style={[type.small, styles.k]}>{k}</Text>
          <Text style={[type.mono, styles.v]}>{v}</Text>
        </View>
      ))}
      {whoami.error ? <Row wrap row={errorRow(whoami.error, 'meta.whoami')} /> : null}
      <View style={styles.pad}>
        <Button
          label="Check scopes"
          disabled={!key}
          onPress={() => {
            const rows = refusals(key?.scopes ?? [], version, host);
            setScopeRows(
              rows.length
                ? rows
                : [{ glyph: '✓', word: 'scopes', subject: 'phone preset', result: 'complete' }],
            );
          }}
        />
      </View>
      {scopeRows?.map((r) => (
        <Row key={r.word} wrap row={r} />
      ))}
      <Text style={[type.small, styles.header]}>Notifications</Text>
      {CATEGORY_LABELS.map(({ key: categoryKey, label }) => (
        <View key={categoryKey} style={styles.kv}>
          <Text style={[type.body, styles.v]}>{label}</Text>
          <Switch
            value={categories[categoryKey]}
            disabled={pushBusy}
            onValueChange={(value) => void applyCategories({ ...categories, [categoryKey]: value })}
          />
        </View>
      ))}
      <View style={styles.pad}>
        <Button
          label="Send test notification"
          disabled={pushBusy}
          onPress={() =>
            void rpc.push
              .test({})
              .then((res) =>
                setPushRow(
                  res.ok
                    ? { glyph: '✓', word: 'push', subject: 'Expo', result: `sent · ${res.sent}` }
                    : { glyph: '✗', word: 'push', subject: 'Expo', result: res.error },
                ),
              )
              .catch((err: unknown) => setPushRow(errorRow(err, 'push.test')))
          }
        />
      </View>
      {pushRow ? <Row wrap row={pushRow} /> : null}
      <Text style={[type.small, styles.header]}>Diagnostics</Text>
      {health.data ? <Row wrap row={health.data.row} /> : null}
      <Text style={[type.small, styles.header]}>This phone</Text>
      <View style={styles.pad}>
        <Button
          label="Disconnect this phone"
          textColor={color.error}
          onPress={() => void unregisterCurrentPush(rpc).finally(() => void disconnect())}
        />
        <Text style={type.small}>
          Revoke this key on the web: Settings → Mobile app → Connected phones, or ethos api-key
          revoke {key?.prefix ?? '<prefix>'}.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  body: { paddingBottom: 32 },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  kv: { minHeight: 36, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  k: { width: 112 },
  v: { flex: 1, color: color.textPrimary },
  pad: { padding: 16, gap: 8 },
});
