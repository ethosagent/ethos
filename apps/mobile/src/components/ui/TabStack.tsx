import { Stack } from 'expo-router';
import { color } from '../../theme/tokens';

/** Each tab is its own native stack; the header is global chrome (`--info`, D4). */
export function TabStack() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.bgBase },
        headerTintColor: color.chrome,
        headerTitleStyle: { color: color.textPrimary },
        headerLargeTitleStyle: { color: color.textPrimary },
        contentStyle: { backgroundColor: color.bgBase },
      }}
    />
  );
}
