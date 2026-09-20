import { remoteHost } from '@ethosagent/sdk';
import { Stack, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import { useConnection } from '../../../src/state/connection';
import { color, type } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/** more — the server row doubles as the connection indicator. The Library rows
 *  (Documents, Recipes, MCP, Plugins, Platforms, Mesh, Dashboards) are Phase 4. */
export default function MoreScreen() {
  const router = useRouter();
  const { url, online } = useConnection();
  const host = (url && remoteHost(url)) ?? '—';
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'More', headerLargeTitle: true }} />
      <Row
        row={
          online
            ? { glyph: '✓', word: 'server', subject: host, result: 'connected' }
            : { glyph: '✗', word: 'server', subject: host, result: 'unreachable' }
        }
        onPress={() => router.push('/more/settings')}
      />
      <Text style={[type.small, styles.header]}>This phone</Text>
      <Row
        row={{ glyph: '·', word: 'settings', subject: 'server, key, diagnostics' }}
        onPress={() => router.push('/more/settings')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
});
