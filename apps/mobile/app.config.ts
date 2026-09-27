import type { ExpoConfig } from 'expo/config';
import { type ConfigPlugin, withEntitlementsPlist } from 'expo/config-plugins';

// One Expo project, three installable variants side by side (T-DIST, R15):
// eas.json sets APP_VARIANT per build profile; a plain `expo start` is dev.
//
// A fourth, `sideload`, is the free-provisioning device build (T7): a personal
// Apple team signs it, so the bundle id must be one that team owns
// (`ETHOS_SIDELOAD_BUNDLE_ID`) and it carries no entitlement a personal team
// cannot hold — no push (`aps-environment`), no time-sensitive notifications.
// Installed with `npx expo run:ios --device --configuration Release`.
const variant: string = process.env.APP_VARIANT ?? 'development';
const sideload = variant === 'sideload';
const bundleId = sideload
  ? process.env.ETHOS_SIDELOAD_BUNDLE_ID
  : (
      {
        development: 'com.ethos.mobile.dev',
        preview: 'com.ethos.mobile.preview',
        production: 'com.ethos.mobile',
      } as Record<string, string>
    )[variant];
if (!bundleId) {
  throw new Error(
    sideload
      ? 'APP_VARIANT=sideload needs ETHOS_SIDELOAD_BUNDLE_ID (a bundle id your personal team owns)'
      : `Unknown APP_VARIANT "${variant}"`,
  );
}
const appleTeamId = sideload ? process.env.ETHOS_APPLE_TEAM_ID : undefined;
if (sideload && !appleTeamId) {
  throw new Error('APP_VARIANT=sideload needs ETHOS_APPLE_TEAM_ID (your personal team id)');
}

/** Personal teams cannot sign push or time-sensitive notifications. Removed at
 *  the entitlements mod rather than by dropping `expo-notifications` from the
 *  plugin list, because prebuild applies that plugin on its own when the
 *  package is installed. */
const withoutPushEntitlements: ConfigPlugin = (config) =>
  withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    delete mod.modResults['com.apple.developer.usernotifications.time-sensitive'];
    return mod;
  });

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
  extra: { variant },
  ios: {
    bundleIdentifier: bundleId,
    ...(appleTeamId ? { appleTeamId } : {}),
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      // Plain http to a LAN / .local host; everything else stays under ATS.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      NSLocalNetworkUsageDescription: 'Ethos connects to the server you run on your own network.',
    },
    // Approval pushes are time-sensitive (R10); Allow once needs Face ID or
    // the passcode, which needs this entitlement to break through Focus.
    // Not on `sideload`: a personal team cannot hold it.
    entitlements: sideload ? {} : { 'com.apple.developer.usernotifications.time-sensitive': true },
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
    // The call engine (T7): background audio keeps a call alive on a locked
    // screen. The lane's TTS arrives as PCM or as whole Ogg Opus / MP3 / WAV
    // clips, and none of those needs FFmpeg: `decodeAudioData` sends every
    // format but MP4/M4A/AAC to miniaudio (`needsFFmpeg`, common/cpp/audioapi/
    // core/utils/AudioDecoding.h), which decodes WAV/MP3/FLAC itself and Ogg
    // Opus/Vorbis through the libopus/libvorbis backends
    // (libs/miniaudio/MiniAudioDecoding.cpp). Those backends are the "static
    // external libs", so `disableStaticExternalLibs` is pinned false: turning
    // it on would silence the pipeline tier's default opus. FFmpeg would add
    // only AAC/M4A/MP4 and URL streaming, which no voice provider emits.
    // RECORD_AUDIO is not in the plugin's Android defaults, so the list is
    // spelled out; the foreground service carries the mic in the background.
    [
      'react-native-audio-api',
      {
        iosBackgroundMode: true,
        iosMicrophonePermission: 'Ethos listens while you are on a call.',
        androidPermissions: [
          'android.permission.RECORD_AUDIO',
          'android.permission.MODIFY_AUDIO_SETTINGS',
          'android.permission.FOREGROUND_SERVICE',
          'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
          'android.permission.FOREGROUND_SERVICE_MICROPHONE',
        ],
        androidFSTypes: ['mediaPlayback', 'microphone'],
        disableFFmpeg: true,
        disableStaticExternalLibs: false,
      },
    ],
  ],
};

// Applied to the config object itself, BEFORE Expo applies `plugins`: a mod
// registered earlier runs later, so this strips what `expo-notifications` has
// already written. (Verified with `expo config --type introspect`.)
export default sideload ? withoutPushEntitlements(config) : config;
