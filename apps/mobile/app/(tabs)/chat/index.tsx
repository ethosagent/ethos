import { useQuery } from '@tanstack/react-query';
import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { errorRow } from '../../../src/api/errors';
import { useRpc } from '../../../src/api/queries';
import { RouteError } from '../../../src/components/ui/RouteError';
import { Row } from '../../../src/components/ui/Row';
import { Skeleton } from '../../../src/components/ui/Skeleton';
import { useConnection } from '../../../src/state/connection';

export { RouteError as ErrorBoundary };

/** Chat's root: the agent just picked on first run, else the latest session,
 *  else a new one with the server's default agent. */
export default function ChatIndex() {
  const rpc = useRpc();
  const picked = useConnection((s) => s.personalityId);
  const latest = useQuery({
    queryKey: ['sessions', 'latest'],
    queryFn: () => rpc.sessions.list({ limit: 1 }),
    enabled: !picked,
  });
  if (picked) {
    return (
      <Redirect
        href={{
          pathname: '/chat/[sessionId]',
          params: { sessionId: 'new', personalityId: picked },
        }}
      />
    );
  }
  if (latest.error) return <Row wrap row={errorRow(latest.error, 'sessions.list')} />;
  if (latest.isPending)
    return (
      <View>
        <Skeleton rows={3} height={48} />
      </View>
    );
  const id = latest.data.items[0]?.id ?? 'new';
  return <Redirect href={{ pathname: '/chat/[sessionId]', params: { sessionId: id } }} />;
}
