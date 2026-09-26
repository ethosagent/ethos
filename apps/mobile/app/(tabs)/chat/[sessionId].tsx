import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatSurface } from '../../../src/components/chat/ChatSurface';
import { RouteError } from '../../../src/components/ui/RouteError';

export { RouteError as ErrorBoundary };

/** The Chat tab's session route — the surface itself is `ChatSurface`, shared
 *  with Agents › New agent. The personality bar replaces the native header. */
export default function ChatScreen() {
  const params = useLocalSearchParams<{ sessionId: string; personalityId?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ChatSurface
        sessionId={params.sessionId}
        personalityId={params.personalityId}
        topInset={insets.top}
        onStarted={(sessionId) => router.setParams({ sessionId })}
      />
    </>
  );
}
