import { personalityAccent } from '@ethosagent/design-tokens';
import { resolveCallTreatment } from '@ethosagent/types';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePersonalities, useRpc } from '../../../src/api/queries';
import { RouteError } from '../../../src/components/ui/RouteError';
import { CallStage } from '../../../src/components/voice/CallStage';
import { callActive } from '../../../src/features/voice/call-stage';
import { clock } from '../../../src/lib/row';
import { useCallMode } from '../../../src/state/call-mode';
import { callStore } from '../../../src/state/call-store';
import { useChatStore } from '../../../src/state/chat-store';
import { color } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * `call` — the Call Stage, a MODE of the Chat tab (§2, T7): no stack header, no
 * PersonalityBar, and no tab bar while it is focused (`call-mode`). Opened by
 * the composer's mic with the chat's personality and session; starts a call on
 * mount unless one is already up (the chat's call strip returns here too).
 */
export default function CallScreen() {
  const params = useLocalSearchParams<{ personalityId?: string; sessionId?: string }>();
  const router = useRouter();
  const rpc = useRpc();
  const insets = useSafeAreaInsets();
  const personalities = usePersonalities();
  const personalityId = params.personalityId ?? personalities.data?.defaultId ?? 'ethos';
  const sessionId = params.sessionId && params.sessionId !== 'new' ? params.sessionId : null;
  const personality = personalities.data?.items.find((p) => p.id === personalityId);
  const clarify = useChatStore((s) => s.chat.pendingClarifies[0] ?? null);

  // Mount only: a param or query settling later must not start a second call.
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once, on mount
  useEffect(() => {
    if (callActive(callStore.getState().call.status)) return;
    useCallMode.getState().setOwner({ personalityId, sessionId });
    callStore.getState().start({ personalityId, ...(sessionId ? { sessionId } : {}) });
  }, []);

  useFocusEffect(
    useCallback(() => {
      useCallMode.getState().setStageFocused(true);
      return () => useCallMode.getState().setStageFocused(false);
    }, []),
  );

  // Shape and colour: the personality's own `voice.call_style`, else derived
  // from its id — the web's precedence (`resolveCallTreatment`). The operator's
  // `display.call_style` / `display.call_accent` live in `config.get`, which
  // the phone preset does not read, so the phone skips that middle step.
  const treatment = resolveCallTreatment({
    personalityId,
    ...(personality?.voice?.call_style
      ? { personalityCallStyle: personality.voice.call_style }
      : {}),
  });

  const leave = (): void => {
    if (router.canGoBack()) router.back();
    else
      router.replace({ pathname: '/chat/[sessionId]', params: { sessionId: sessionId ?? 'new' } });
  };

  return (
    <>
      <Stack.Screen
        options={{ headerShown: false, contentStyle: { backgroundColor: color.bgBase } }}
      />
      <CallStage
        personalityId={personalityId}
        name={personality?.name ?? personalityId}
        treatment={treatment}
        accent={personalityAccent(personalityId)}
        clarify={clarify}
        onAnswerClarify={async (requestId, answer) => {
          await rpc.clarify.respond({ requestId, answer, source: 'user' });
          useChatStore.getState().notice({
            glyph: '✓',
            word: 'answered',
            subject: 'clarify',
            result: answer,
            time: clock(Date.now()),
          });
        }}
        onLeave={leave}
        topInset={insets.top}
        bottomInset={insets.bottom + 8}
      />
    </>
  );
}
