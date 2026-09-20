import { StyleSheet, View } from 'react-native';
import { color } from '../../theme/tokens';

/** Lists load as static skeletons at the real row height — never a spinner (§11a). */
export function Skeleton({ rows = 5, height }: { rows?: number; height: number }) {
  return (
    <View accessibilityLabel="Loading" accessible>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
        <View key={i} style={[styles.bar, { height: height - 12 }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: color.bgOverlay,
    marginHorizontal: 16,
    marginVertical: 6,
    borderRadius: 4,
  },
});
