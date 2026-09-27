import { callStripVisible, voiceCaption } from '@ethosagent/voice-client';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  AX3_FONT_SCALE,
  callActive,
  callNoticeRows,
  STATUS_LABEL,
} from '../../features/voice/call-stage';
import { callStore, useCallStore } from '../../state/call-store';
import { color, type } from '../../theme/tokens';
import { Button } from '../ui/Button';
import { Row } from '../ui/Row';

/**
 * The chat's "call in progress" strip (DESIGN.md § "CallStrip"): while a call
 * is up and the user went Back to chat, one row with the state word and the
 * live caption that returns to the stage; after a call that ended with
 * something to explain (mic denied, degraded, an error, the budget sign-off),
 * its rows and a Dismiss. Visibility is the package's `callStripVisible`.
 */
export function CallStrip({ accent, onOpen }: { accent: string; onOpen: () => void }) {
  const call = useCallStore((s) => s.call);
  const held = useCallStore((s) => s.held);
  if (!callStripVisible(call)) return null;

  if (callActive(call.status)) {
    const caption = voiceCaption(call);
    const word = held ? 'held · phone call' : STATUS_LABEL[call.status];
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Call in progress, ${word}. Return to call`}
        onPress={onOpen}
        style={({ pressed }) => [styles.strip, pressed ? styles.pressed : null]}
      >
        <Text style={{ color: accent }}>●</Text>
        <Text style={type.mono} maxFontSizeMultiplier={AX3_FONT_SCALE}>
          {word}
        </Text>
        <Text
          style={[type.small, styles.flex]}
          numberOfLines={1}
          maxFontSizeMultiplier={AX3_FONT_SCALE}
        >
          {caption ?? ''}
        </Text>
        <Text style={[type.small, { color: color.chrome }]} maxFontSizeMultiplier={AX3_FONT_SCALE}>
          Return ›
        </Text>
      </Pressable>
    );
  }

  return (
    <View>
      {callNoticeRows(call, false).map((row) => (
        <Row key={`${row.word}-${row.subject}`} row={row} wrap />
      ))}
      <View style={styles.pad}>
        <Button label="Dismiss" onPress={() => callStore.getState().dismissNotice()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    minHeight: 44,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: color.borderSubtle,
  },
  pressed: { backgroundColor: color.bgOverlay },
  flex: { flex: 1 },
  pad: { paddingHorizontal: 16, paddingBottom: 4 },
});
