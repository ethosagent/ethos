import { Pressable, StyleSheet, Text } from 'react-native';
import { color, radius, type } from '../../theme/tokens';

/** 44 pt, 1 px border, no fill — the only filled buttons are Connect and send (§10). */
export function Button({
  label,
  onPress,
  disabled,
  filled,
  textColor = color.textPrimary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  textColor?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        filled ? styles.filled : null,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.label, { color: filled ? color.bgBase : textColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
  },
  filled: { backgroundColor: color.chrome, borderColor: color.chrome },
  pressed: { backgroundColor: color.bgOverlay },
  disabled: { opacity: 0.4 },
  label: { ...type.body, fontWeight: '500' },
});
