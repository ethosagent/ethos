import '../src/polyfills';
import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { hideAsync, preventAutoHideAsync } from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { queryClient } from '../src/api/queries';
import { probeHealth } from '../src/auth/probes';
import { RouteError } from '../src/components/ui/RouteError';
import { foreground } from '../src/features/chat/session';
import {
  registerNotificationResponseHandler,
  routeColdStartNotification,
} from '../src/push/handlers';
import { useConnection } from '../src/state/connection';
import { color } from '../src/theme/tokens';

export { RouteError as ErrorBoundary };

// Every promise started here is fired and forgotten, so each one ends in a
// catch: an unhandled rejection is a full-screen error under Expo Go.
preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const { loaded, key, onboarding } = useConnection();

  useEffect(() => {
    void useConnection
      .getState()
      .hydrate()
      .then(() => hideAsync())
      .catch(() => undefined);
    // D13: every stream closes on background; foreground reconnects or
    // rehydrates, and probes /healthz once for the offline state.
    const sub = AppState.addEventListener('change', (state) => {
      void foreground.onAppState(state);
      const { url } = useConnection.getState();
      if (state === 'active' && url) {
        void probeHealth(url).then((h) => useConnection.getState().set({ online: h.ok }));
      }
    });
    // T4: the one action path, whether foregrounded, backgrounded, or a
    // killed-app background launch — registered here so it exists before any
    // response can arrive.
    const offNotification = registerNotificationResponseHandler();
    // The one launched-from-killed case the listener above never sees itself
    // (`handlers.ts` dedupes against the listener by notification id).
    routeColdStartNotification().catch(() => undefined);
    return () => {
      sub.remove();
      offNotification();
    };
  }, []);

  if (!loaded) return null;
  const ready = !!key && !onboarding;
  return (
    <QueryClientProvider client={queryClient}>
      <KeyboardProvider>
        <ActionSheetProvider>
          <Stack
            screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bgBase } }}
          >
            <Stack.Protected guard={!ready}>
              <Stack.Screen name="(connect)" />
            </Stack.Protected>
            <Stack.Protected guard={ready}>
              <Stack.Screen name="(tabs)" />
            </Stack.Protected>
          </Stack>
        </ActionSheetProvider>
      </KeyboardProvider>
    </QueryClientProvider>
  );
}
