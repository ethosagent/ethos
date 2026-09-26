import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useRpc } from '../../../../src/api/queries';
import {
  AgentScreenHeader,
  KvGroups,
  useListBottomInset,
} from '../../../../src/components/agents/AgentParts';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { sheetGroups } from '../../../../src/features/agents/character-sheet';
import { color } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/** agent:<id> — Sheet: `personalities.characterSheet` (the artifact
 *  `ethos personality show` prints) as read-only key/value groups (D12). */
export default function AgentSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const rpc = useRpc();
  const bottomInset = useListBottomInset();
  const sheet = useQuery({
    queryKey: ['personalities', 'characterSheet', id],
    queryFn: () => rpc.personalities.characterSheet({ id }),
  });
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
    >
      <AgentScreenHeader id={id} segment="sheet" />
      {sheet.error ? <Row wrap row={errorRow(sheet.error, 'characterSheet')} /> : null}
      {sheet.isPending ? <Skeleton rows={4} height={36} /> : null}
      {sheet.data ? <KvGroups groups={sheetGroups(sheet.data.markdown)} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
});
