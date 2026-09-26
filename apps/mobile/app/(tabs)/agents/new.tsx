import { Stack } from 'expo-router';
import { useState } from 'react';
import { ChatSurface } from '../../../src/components/chat/ChatSurface';
import { RouteError } from '../../../src/components/ui/RouteError';
import { ARCHITECT_ID } from '../../../src/features/agents/grouping';

export { RouteError as ErrorBoundary };

/** agent-new (§5): the chat surface unchanged, talking to the Personality
 *  Architect. The quick-create dialog is desktop-only. The native header stays
 *  so Back returns to Agents; the adopted session id lives in this screen. */
export default function NewAgent() {
  const [sessionId, setSessionId] = useState('new');
  return (
    <>
      <Stack.Screen options={{ title: 'New agent' }} />
      <ChatSurface
        sessionId={sessionId}
        personalityId={ARCHITECT_ID}
        topInset={0}
        onStarted={setSessionId}
      />
    </>
  );
}
