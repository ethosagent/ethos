import { personalityAccent } from '@ethosagent/design-tokens';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useRpc } from '../../../../src/api/queries';
import { Button } from '../../../../src/components/ui/Button';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import {
  isResolved,
  pendingDetail,
  pendingKey,
  pendingText,
} from '../../../../src/features/agents/pending-memory';
import type { RowData } from '../../../../src/lib/row';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * memory-approve (§5): a native formSheet — the system asks, so it sheets up
 * (D6, R11). Store / action / from, the content in a bordered box, then
 * Reject · Approve: two equal-weight bordered 44 pt buttons, neither filled
 * (§12 amendment 15). On tap both disable with their labels unchanged and the
 * slot reads `deciding…`; the sheet closes once the pending list no longer
 * carries the id. A failed decision resolves in place as a row.
 */
export default function MemoryApprove() {
  const { id, pendingId } = useLocalSearchParams<{ id: string; pendingId: string }>();
  const rpc = useRpc();
  const router = useRouter();
  const queries = useQueryClient();
  const pending = useQuery({
    queryKey: pendingKey(id),
    queryFn: () => rpc.memory.pendingList({ personalityId: id }),
  });
  const [deciding, setDeciding] = useState(false);
  const [failure, setFailure] = useState<RowData | null>(null);
  const list = pending.data?.pending;
  const item = list?.find((p) => p.id === pendingId);
  const resolved = isResolved(list, pendingId);

  useEffect(() => {
    if (resolved && router.canGoBack()) router.back();
  }, [resolved, router]);

  const decide = async (verb: 'approve' | 'reject') => {
    setDeciding(true);
    setFailure(null);
    try {
      const input = { personalityId: id, id: pendingId };
      if (verb === 'approve') await rpc.memory.pendingApprove(input);
      else await rpc.memory.pendingReject(input);
      await queries.invalidateQueries({ queryKey: pendingKey(id) });
      await queries.invalidateQueries({ queryKey: ['memory', 'get', id] });
    } catch (err) {
      setFailure(errorRow(err, `memory.pending${verb === 'approve' ? 'Approve' : 'Reject'}`));
      setDeciding(false);
    }
  };

  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={type.h4}>
        Memory write
      </Text>
      {pending.error ? <Row wrap row={errorRow(pending.error, 'memory.pendingList')} /> : null}
      {item ? (
        <>
          {pendingDetail(item).map((d) => (
            <View key={d.key} style={styles.kv}>
              <Text style={[type.small, styles.key]}>{d.key}</Text>
              <Text style={[type.mono, styles.value]}>{d.value}</Text>
            </View>
          ))}
          {pendingText(item.update) ? (
            <View style={styles.box}>
              <Text style={type.body} selectable>
                {pendingText(item.update)}
              </Text>
            </View>
          ) : null}
          <View style={styles.slot}>
            {deciding ? <Text style={type.mono}>deciding…</Text> : null}
            {failure ? <Row wrap row={failure} /> : null}
          </View>
          <View style={styles.actions}>
            <Button
              label="Reject"
              textColor={color.error}
              disabled={deciding}
              onPress={() => void decide('reject')}
            />
            <Button
              label="Approve"
              textColor={personalityAccent(id)}
              disabled={deciding}
              onPress={() => void decide('approve')}
            />
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.bgElevated },
  content: { padding: 16, gap: 8 },
  kv: { flexDirection: 'row', minHeight: 36, alignItems: 'center', gap: 8 },
  key: { width: 112 },
  value: { flex: 1 },
  box: {
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
  },
  slot: { minHeight: 28, justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 12 },
});
