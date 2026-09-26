import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { color } from '../../theme/tokens';

/** Each tab is its own native stack; the header is global chrome (`--info`, D4).
 *  `children` are per-route `Stack.Screen` overrides — a presentation such as
 *  a native formSheet must be known before the route is pushed. */
export function TabStack({ children }: { children?: ReactNode }) {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.bgBase },
        headerTintColor: color.chrome,
        headerTitleStyle: { color: color.textPrimary },
        headerLargeTitleStyle: { color: color.textPrimary },
        contentStyle: { backgroundColor: color.bgBase },
      }}
    >
      {children}
    </Stack>
  );
}
