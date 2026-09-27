import { Redirect, useLocalSearchParams } from 'expo-router';

export { RouteError as ErrorBoundary } from '../../../../src/components/ui/RouteError';

/** `/teams/<team>` opens on its Overview segment. */
export default function TeamIndex() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  return <Redirect href={{ pathname: '/teams/[teamId]/overview', params: { teamId } }} />;
}
