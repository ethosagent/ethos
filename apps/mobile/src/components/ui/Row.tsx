import { Pressable, StyleSheet, Text } from 'react-native';
import type { Glyph, RowData } from '../../lib/row';
import { color, type } from '../../theme/tokens';

const GLYPH_COLOR: Record<Glyph, string> = {
  '✓': color.success,
  '✗': color.error,
  '⚠': color.warning,
  '·': color.textTertiary,
};

/**
 * The one feedback row (D7, §10): glyph + word, mono subject, result, time.
 * Never colour alone. The result truncates first, the subject middle-ellipsizes
 * second, the glyph-word and the time never truncate. `wrap` lets a row whose
 * result IS the instruction (a probe refusal) run to more lines.
 */
export function Row({
  row,
  onPress,
  wrap,
}: {
  row: RowData;
  onPress?: () => void;
  wrap?: boolean;
}) {
  const label = [row.word, row.subject, row.result, row.time].filter(Boolean).join(', ');
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      accessible
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <Text style={[styles.gw, { color: GLYPH_COLOR[row.glyph] }]}>
        {row.glyph} {row.word}
      </Text>
      <Text style={styles.subject} numberOfLines={wrap ? undefined : 1} ellipsizeMode="middle">
        {row.subject}
      </Text>
      {row.result ? (
        <Text style={styles.result} numberOfLines={wrap ? undefined : 1}>
          {row.result}
        </Text>
      ) : null}
      {row.time ? <Text style={styles.time}>{row.time}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 40,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pressed: { backgroundColor: color.bgOverlay },
  gw: { ...type.small, minWidth: 74, flexShrink: 0 },
  subject: { ...type.mono, flexShrink: 1, maxWidth: '45%' },
  result: { ...type.body, flex: 1, flexShrink: 2 },
  time: { ...type.mono, color: color.textTertiary, flexShrink: 0 },
});
