import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useRouter } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { parseDeepLink } from '../../src/auth/deep-link';
import { Button } from '../../src/components/ui/Button';
import { RouteError } from '../../src/components/ui/RouteError';
import { Row } from '../../src/components/ui/Row';
import { useConnection } from '../../src/state/connection';
import { color } from '../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * ob-pair — scan-only (D3). The scanned string goes straight to the parser and
 * into memory for the Connect form; it is never opened as a URL, so the key
 * never passes through the OS URL dispatcher.
 */
export default function ScanScreen() {
  const router = useRouter();
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);

  const body = !permission ? null : permission.granted ? (
    <CameraView
      style={styles.camera}
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={({ data }) => {
        const link = parseDeepLink(data);
        if (done.current || link?.kind !== 'connect') return;
        done.current = true;
        useConnection.getState().set({ draft: { url: link.url, key: link.key } });
        router.back();
      }}
    />
  ) : permission.canAskAgain ? (
    <Button label="Allow the camera" onPress={() => void request()} />
  ) : (
    <Row
      wrap
      row={{
        glyph: '✗',
        word: 'camera',
        subject: 'denied',
        result: 'type the URL and key instead',
      }}
    />
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Scan a QR code' }} />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase, padding: 16, gap: 12 },
  camera: { flex: 1, borderRadius: 8 },
});
