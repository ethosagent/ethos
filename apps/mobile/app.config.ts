import type { ExpoConfig } from 'expo/config';

// One Expo project, three installable variants side by side (T-DIST, R15):
// eas.json sets APP_VARIANT per build profile; a plain `expo start` is dev.
const variant: string = process.env.APP_VARIANT ?? 'development';
const bundleId = (
  {
    development: 'com.ethos.mobile.dev',
    preview: 'com.ethos.mobile.preview',
    production: 'com.ethos.mobile',
  } as Record<string, string>
)[variant];
if (!bundleId) throw new Error(`Unknown APP_VARIANT "${variant}"`);

const config: ExpoConfig = {
  name: variant === 'production' ? 'Ethos' : `Ethos (${variant})`,
  slug: 'ethos',
  scheme: 'ethos',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  // No web target (D1: the phone is the remote; the browser already has
  // `apps/web`). It is not just unbuilt, it cannot work: `expo-secure-store`'s
  // web implementation is an empty stub, and the key lives in the Keychain —
  // so Connect would fail on its first read. The camera scanner (D3) and the
  // native tab bar (R11) are likewise iOS/Android only. Declaring this stops
  // `expo start` offering a `w` that can only ever fail to resolve
  // `react-native-web`.
  platforms: ['ios', 'android'],
  ios: {
    bundleIdentifier: bundleId,
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      // Plain http to a LAN / .local host; everything else stays under ATS.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      NSLocalNetworkUsageDescription: 'Ethos connects to the server you run on your own network.',
    },
    // Approval pushes are time-sensitive (R10); Allow once needs Face ID or
    // the passcode, which needs this entitlement to break through Focus.
    entitlements: { 'com.apple.developer.usernotifications.time-sensitive': true },
  },
  android: {
    package: bundleId,
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-camera',
      { cameraPermission: 'Scan the QR code Ethos shows you.', recordAudioAndroid: false },
    ],
    // Android has no LAN-only cleartext equivalent of ATS NSAllowsLocalNetworking (R17).
    ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    // `mode` sets the `aps-environment` entitlement (development vs. production APNs).
    ['expo-notifications', { mode: variant === 'production' ? 'production' : 'development' }],
  ],
};

export default config;
