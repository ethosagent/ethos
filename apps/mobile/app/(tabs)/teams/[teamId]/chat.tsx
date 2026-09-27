import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useTeams } from '../../../../src/api/queries';
import { ChatSurface } from '../../../../src/components/chat/ChatSurface';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { color } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * team-chat (§6): the chat surface unchanged, talking to the team's
 * coordinator — its accent, bar `<mark> CMO · model · marketing · coordinator`,
 * placeholder `Ask marketing…`. The coordinator already runs on its
 * team-scoped loop, so board mutations arrive as trail rows like any tool.
 * The native header stays so Back returns to the team; the adopted session
 * id lives in this screen, as Agents › New agent does.
 */
export default function TeamChat() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const teams = useTeams();
  const [sessionId, setSessionId] = useState('new');
  const team = teams.data?.items.find((t) => t.name === teamId);
  const coordinator = team?.coordinator ?? null;

  return (
    <>
      <Stack.Screen options={{ title: `${teamId} · chat`, headerBackTitle: teamId }} />
      {coordinator ? (
        <ChatSurface
          sessionId={sessionId}
          personalityId={coordinator}
          topInset={0}
          onStarted={setSessionId}
          barContext={`${teamId} · coordinator`}
          placeholder={`Ask ${teamId}…`}
        />
      ) : (
        <View style={styles.screen}>
          {teams.error ? <Row wrap row={errorRow(teams.error, 'teams.list')} /> : null}
          {teams.isPending ? <Skeleton rows={3} height={48} /> : null}
          {teams.data ? (
            <Row
              wrap
              row={{
                glyph: '·',
                word: 'no lead',
                subject: teamId,
                result: 'this team has no coordinator to talk to',
              }}
            />
          ) : null}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase, paddingTop: 16 },
});
