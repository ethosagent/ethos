import type { ApprovalRequest, ApprovalScope } from '@ethosagent/web-contracts';
import { NotificationFeedbackType, notificationAsync } from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { SlideInUp } from 'react-native-reanimated';
import { errorRow } from '../../api/errors';
import type { RowData } from '../../lib/row';
import { color, motion, radius, type } from '../../theme/tokens';
import { Button } from './Button';
import { Row } from './Row';

// The web's exact copy (apps/web/src/components/chat/ApprovalModal.tsx).
const SCOPES: Array<{ value: ApprovalScope; label: string; hint: string }> = [
  {
    value: 'once',
    label: 'Just this command',
    hint: 'Allow this single invocation, ask again next time.',
  },
  {
    value: 'exact-args',
    label: 'This exact command',
    hint: 'Allow this tool with these exact arguments forever.',
  },
  {
    value: 'any-args',
    label: 'Any args for this tool',
    hint: 'Allow every future invocation of this tool, regardless of args.',
  },
];

export type Decision = { allow: true; scope: ApprovalScope } | { allow: false };

/**
 * An agent asking permission slides DOWN from the personality bar (D6), 180 ms.
 * It names the agent and the tool before the args; two equal bordered buttons,
 * neither filled. A tap disables both with labels unchanged until the server
 * answers — a second tap is impossible — and `approval.resolved` closes it
 * (the parent stops rendering it). Swiping never decides (D16).
 */
export function ApprovalPanel({
  request,
  agent,
  accent,
  queued,
  onDecide,
  onDeciding,
}: {
  request: ApprovalRequest;
  agent: string;
  accent: string;
  queued: number;
  onDecide: (decision: Decision) => Promise<unknown>;
  onDeciding: (deciding: boolean) => void;
}) {
  const [scope, setScope] = useState<ApprovalScope>('once');
  const [inFlight, setInFlight] = useState(false);
  // A ref, not the state: two taps inside one frame both see stale state.
  const sent = useRef(false);
  const [failure, setFailure] = useState<RowData | null>(null);

  useEffect(() => {
    Keyboard.dismiss();
    void notificationAsync(NotificationFeedbackType.Warning);
  }, []);
  // Resolved (from here or elsewhere) → the parent unmounts the panel.
  useEffect(() => () => onDeciding(false), [onDeciding]);

  const decide = async (decision: Decision): Promise<void> => {
    if (sent.current) return;
    sent.current = true;
    setInFlight(true);
    setFailure(null);
    onDeciding(true);
    try {
      await onDecide(decision);
    } catch (err) {
      sent.current = false;
      setInFlight(false);
      onDeciding(false);
      setFailure(errorRow(err, decision.allow ? 'tools.approve' : 'tools.deny'));
    }
  };

  return (
    <Animated.View
      entering={SlideInUp.duration(motion.defaultMs)}
      style={styles.panel}
      accessibilityRole="alert"
    >
      <Text style={type.small}>
        {agent} wants to run a tool{queued > 1 ? ` · ${queued} pending` : ''}
      </Text>
      <Text style={[type.mono, styles.tool]}>{request.toolName}</Text>
      {request.reason ? <Text style={type.body}>{request.reason}</Text> : null}
      <Text style={[type.mono, styles.args]} numberOfLines={8}>
        {JSON.stringify(request.args, null, 2)}
      </Text>
      <View accessibilityRole="radiogroup">
        {SCOPES.map((s) => (
          <Pressable
            key={s.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: scope === s.value, disabled: inFlight }}
            accessibilityLabel={`${s.label}. ${s.hint}`}
            disabled={inFlight}
            onPress={() => setScope(s.value)}
            style={styles.radio}
          >
            <Text style={[type.body, { color: scope === s.value ? accent : color.textTertiary }]}>
              {scope === s.value ? '●' : '○'}
            </Text>
            <View style={styles.radioText}>
              <Text style={type.body}>{s.label}</Text>
              <Text style={type.small}>{s.hint}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      {failure ? <Row row={failure} wrap /> : null}
      <View style={styles.buttons}>
        <Button
          label="Deny"
          textColor={color.error}
          disabled={inFlight}
          onPress={() => void decide({ allow: false })}
        />
        <Button
          label="Allow"
          textColor={accent}
          disabled={inFlight}
          onPress={() => void decide({ allow: true, scope })}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    padding: 16,
    gap: 8,
    backgroundColor: color.bgElevated,
    borderColor: color.borderStrong,
    borderWidth: 1,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
  },
  tool: { color: color.textPrimary },
  args: {
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.sm,
    padding: 8,
  },
  radio: { minHeight: 44, flexDirection: 'row', gap: 10, alignItems: 'center' },
  radioText: { flex: 1 },
  buttons: { flexDirection: 'row', gap: 12 },
});
