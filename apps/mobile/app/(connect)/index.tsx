import { normalizeRemoteUrl, remoteHost } from '@ethosagent/sdk';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { makeClient } from '../../src/api/client';
import {
  type HealthProbe,
  probeHealth,
  probeWhoami,
  refusals,
  type WhoamiProbe,
  waiting,
} from '../../src/auth/probes';
import { Button } from '../../src/components/ui/Button';
import { RouteError } from '../../src/components/ui/RouteError';
import { Row } from '../../src/components/ui/Row';
import type { RowData } from '../../src/lib/row';
import { useConnection } from '../../src/state/connection';
import { color, radius, type } from '../../src/theme/tokens';

export { RouteError as ErrorBoundary };

const KEY_PREFIX = 'sk-ethos-';

/**
 * ob-connect (§1). URL + key, two probe rows, and Connect enabled only when
 * both answered AND the server is new enough AND the key carries the phone's
 * scopes. Probes run on blur and again on Connect — never per keystroke.
 */
export default function ConnectScreen() {
  const router = useRouter();
  const { url: savedUrl, draft, set, connect } = useConnection();
  const [url, setUrl] = useState(savedUrl ?? '');
  const [key, setKey] = useState('');
  const [health, setHealth] = useState<HealthProbe | null>(null);
  const [who, setWho] = useState<WhoamiProbe | null>(null);
  const [failure, setFailure] = useState<RowData | null>(null);
  const run = useRef(0);

  const probe = useCallback(async (u: string, k: string) => {
    const id = ++run.current;
    const origin = normalizeRemoteUrl(u);
    setHealth(null);
    setWho(null);
    setFailure(null);
    if (!origin) return null;
    const h = await probeHealth(origin);
    if (id !== run.current) return null;
    setHealth(h);
    if (!h.ok || !k.startsWith(KEY_PREFIX)) return null;
    const host = remoteHost(origin) ?? origin;
    const w = await probeWhoami(() => makeClient(origin, k).rpc.meta.whoami(), {
      host,
      version: h.version,
    });
    if (id !== run.current) return null;
    setWho(w);
    return w.ok && refusals(w.scopes, h.version, host).length === 0 ? origin : null;
  }, []);

  // A scanned QR arrives through memory, never through a URL (D3).
  useEffect(() => {
    if (!draft) return;
    setUrl(draft.url);
    setKey(draft.key);
    set({ draft: null });
    void probe(draft.url, draft.key);
  }, [draft, set, probe]);

  const origin = normalizeRemoteUrl(url);
  const host = origin ? (remoteHost(origin) ?? origin) : '';
  const blocked = health?.ok && who?.ok ? refusals(who.scopes, health.version, host) : [];
  const ready = !!health?.ok && !!who?.ok && blocked.length === 0;
  const keyRow =
    key && !key.startsWith(KEY_PREFIX)
      ? { glyph: '✗' as const, word: 'key', subject: 'format', result: `starts with ${KEY_PREFIX}` }
      : null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Connect to your Ethos' }} />
      <Text style={type.small}>Server URL</Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        onBlur={() => void probe(url, key)}
        placeholder="http://192.168.1.20:3000"
        placeholderTextColor={color.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={[type.mono, styles.input]}
      />
      <Text style={type.small}>API key</Text>
      <TextInput
        value={key}
        onChangeText={setKey}
        onBlur={() => void probe(url, key)}
        placeholder={`${KEY_PREFIX}…`}
        placeholderTextColor={color.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={[type.mono, styles.input]}
      />
      <Text style={type.small}>
        This key lets the phone read, approve and talk. It cannot change agents or settings.
      </Text>
      <View style={styles.rows}>
        {keyRow ? <Row row={keyRow} /> : null}
        <Row wrap row={health?.row ?? waiting('GET /healthz')} />
        <Row wrap row={who?.row ?? waiting('meta.whoami')} />
        {blocked.map((r) => (
          <Row key={r.word} wrap row={r} />
        ))}
        {failure ? <Row wrap row={failure} /> : null}
      </View>
      <Button
        label="Connect"
        filled
        disabled={!ready}
        onPress={() =>
          void probe(url, key).then(async (ok) => {
            if (!ok) return;
            const failed = await connect(ok, key);
            if (failed) setFailure(failed);
            else router.push('/agents');
          })
        }
      />
      <Button label="Scan a QR code" onPress={() => router.push('/scan')} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  body: { padding: 16, gap: 10 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    color: color.textPrimary,
  },
  rows: { marginHorizontal: -16, marginVertical: 8 },
});
