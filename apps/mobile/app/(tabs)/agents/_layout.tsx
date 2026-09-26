import { Stack } from 'expo-router';
import { TabStack } from '../../../src/components/ui/TabStack';
import { color } from '../../../src/theme/tokens';

export { RouteError as ErrorBoundary } from '../../../src/components/ui/RouteError';

/** The Agents stack. The memory-write review is a system ask, so it is a
 *  native formSheet (D6, R11) — grabber and presentation motion are the
 *  system's; its content sits on `--bg-elevated` (§10 `Sheet`). */
export default function AgentsLayout() {
  return (
    <TabStack>
      <Stack.Screen
        name="[id]/memory-approve"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.6, 1],
          sheetGrabberVisible: true,
          headerShown: false,
          contentStyle: { backgroundColor: color.bgElevated },
        }}
      />
    </TabStack>
  );
}
