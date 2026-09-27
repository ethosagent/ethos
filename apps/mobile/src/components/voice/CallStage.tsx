import { type CallTreatment, callStageVisual } from '@ethosagent/voice-client';
import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  AX3_FONT_SCALE,
  callNoticeRows,
  callStageTurns,
  clarifySlotHeight,
  hasDismissibleNotice,
  STATUS_LABEL,
  stageFooter,
} from '../../features/voice/call-stage';
import { clock, type RowData } from '../../lib/row';
import { callStore, useCallStore } from '../../state/call-store';
import { color, radius, type } from '../../theme/tokens';
import { ClarifyCard } from '../ui/ChatParts';
import { Mark } from '../ui/Mark';
import { Row } from '../ui/Row';
import { CallShape } from './CallShape';

const MAX_SCALE = AX3_FONT_SCALE;

/**
 * The Call Stage (T7, DESIGN.md § "Call Stage") in portrait: identity and the
 * mono `provider · model · NNNms` line, the shape, the state word, the status
 * rows, this call's turns with the reserved clarify slot at their base, and
 * four equal-weight bordered controls. No PersonalityBar and no header: the
 * one way out that keeps the call is Back to chat; End hangs up.
 *
 * Reads the call from `call-store`; the clarify comes from the chat store via
 * the route (it is the session's question, not the call's).
 */
export function CallStage(props: {
  personalityId: string;
  name: string;
  treatment: CallTreatment;
  accent: string;
  /** The session's first pending clarify, or null — the slot is dimmed. */
  clarify: ClarifyRequestEvent | null;
  onAnswerClarify: (requestId: string, answer: string) => Promise<void>;
  /** Leave the stage (navigation). The call is untouched. */
  onLeave: () => void;
  topInset: number;
  bottomInset: number;
}) {
  const call = useCallStore((s) => s.call);
  const muted = useCallStore((s) => s.muted);
  const pushToTalk = useCallStore((s) => s.pushToTalk);
  const held = useCallStore((s) => s.held);
  const latency = useCallStore((s) => s.latency);
  const providerLabel = useCallStore((s) => s.providerLabel)();
  const { fontScale, width } = useWindowDimensions();
  const [answered, setAnswered] = useState<{ requestId: string; row: RowData } | null>(null);
  const [failure, setFailure] = useState<RowData | null>(null);

  const visual = callStageVisual(call.status);
  const turns = callStageTurns(call.transcript, props.name);
  const notices = callNoticeRows(call, held);
  const footer = stageFooter(providerLabel, latency.totalMs);
  const shapeSize = Math.round(Math.min(width * 0.55, fontScale > 1.5 ? 140 : 220));
  const slotHeight = clarifySlotHeight(fontScale);
  const question =
    props.clarify && props.clarify.requestId !== answered?.requestId ? props.clarify : null;

  // Answered → the slot collapses to the resolved row (nothing vanishes, D7);
  // a refused answer keeps the card with the reason under it.
  const answer = (requestId: string, text: string): void => {
    setFailure(null);
    props
      .onAnswerClarify(requestId, text)
      .then(() =>
        setAnswered({
          requestId,
          row: {
            glyph: '✓',
            word: 'answered',
            subject: 'clarify',
            result: text,
            time: clock(Date.now()),
          },
        }),
      )
      .catch((err: unknown) =>
        setFailure({
          glyph: '✗',
          word: 'clarify',
          subject: 'not sent',
          result: err instanceof Error ? err.message : String(err),
        }),
      );
  };

  const end = (): void => {
    callStore.getState().end();
    props.onLeave();
  };

  return (
    <View
      style={[styles.screen, { paddingTop: props.topInset + 8, paddingBottom: props.bottomInset }]}
      accessibilityLabel={`Call with ${props.name}`}
    >
      <View style={styles.identity}>
        <Mark personalityId={props.personalityId} size={30} />
        <Text style={type.h4} maxFontSizeMultiplier={MAX_SCALE} numberOfLines={1}>
          {props.name}
        </Text>
      </View>
      {footer ? (
        <Text style={[type.mono, styles.center]} maxFontSizeMultiplier={MAX_SCALE}>
          {footer}
        </Text>
      ) : null}

      <View style={styles.stage}>
        <CallShape
          state={visual}
          treatment={props.treatment}
          accent={props.accent}
          name={props.name}
          size={shapeSize}
          micLevel={() => callStore.getState().micLevel()}
          agentLevel={() => callStore.getState().agentLevel()}
        />
        <Text
          style={[type.mono, styles.center]}
          maxFontSizeMultiplier={MAX_SCALE}
          accessibilityRole="text"
          accessibilityLiveRegion="polite"
        >
          {held ? 'held · phone call' : STATUS_LABEL[call.status]}
        </Text>
      </View>

      {notices.map((row) => (
        <Row key={`${row.word}-${row.subject}`} row={row} wrap />
      ))}
      {hasDismissibleNotice(call) ? (
        <View style={styles.pad}>
          <Control
            label="Dismiss"
            a11y="Dismiss notice"
            onPress={() => callStore.getState().dismissNotice()}
          />
        </View>
      ) : null}

      <View style={styles.column}>
        <Text style={[type.mono, styles.columnHead]} maxFontSizeMultiplier={MAX_SCALE}>
          This call
        </Text>
        <ScrollView style={styles.turns} contentContainerStyle={styles.turnsBody}>
          {turns.map((turn) => (
            <View key={turn.id} style={styles.turn}>
              <Text
                style={[type.mono, turn.live ? { color: props.accent } : null]}
                maxFontSizeMultiplier={MAX_SCALE}
              >
                {turn.label}
              </Text>
              <Text
                style={[type.body, turn.filler ? styles.filler : null]}
                maxFontSizeMultiplier={MAX_SCALE}
              >
                {turn.text}
              </Text>
            </View>
          ))}
        </ScrollView>
        <View
          testID="clarify-slot"
          accessibilityLabel={question ? 'Question from the agent' : 'No open question'}
          style={[
            styles.slot,
            { height: slotHeight },
            question || answered ? null : styles.slotEmpty,
          ]}
        >
          {question ? (
            <ScrollView>
              <ClarifyCard
                key={question.requestId}
                request={question}
                agent={props.name}
                onAnswer={(a) => answer(question.requestId, a)}
              />
              {failure ? <Row row={failure} wrap /> : null}
            </ScrollView>
          ) : answered ? (
            <Row row={answered.row} wrap />
          ) : (
            <>
              <Text style={type.mono} maxFontSizeMultiplier={MAX_SCALE}>
                Asked aloud
              </Text>
              <Text style={type.small} maxFontSizeMultiplier={MAX_SCALE}>
                No open question
              </Text>
            </>
          )}
        </View>
      </View>

      <View style={styles.controls}>
        <Control
          label={muted ? 'Unmute' : 'Mute'}
          a11y={muted ? 'Unmute microphone' : 'Mute microphone'}
          selected={muted}
          onPress={() => callStore.getState().toggleMute()}
        />
        <Control
          label="Hold to talk"
          a11y="Push to talk"
          hint="Hold to open the microphone; release to close it"
          selected={pushToTalk && !muted}
          onPressIn={() => callStore.getState().holdToTalk()}
          onPressOut={() => callStore.getState().releaseToTalk()}
        />
        <Control
          label="Back to chat"
          a11y="Back to chat — the call keeps running"
          onPress={props.onLeave}
        />
        <Control label="End" a11y="End call" textColor={color.error} onPress={end} />
      </View>
    </View>
  );
}

/** 44 pt, 1 px `--border-strong`, no fill (§10, §12 amendment 15). */
function Control(props: {
  label: string;
  a11y: string;
  hint?: string;
  selected?: boolean;
  textColor?: string;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11y}
      {...(props.hint ? { accessibilityHint: props.hint } : {})}
      accessibilityState={{ selected: !!props.selected }}
      {...(props.onPress ? { onPress: props.onPress } : {})}
      {...(props.onPressIn ? { onPressIn: props.onPressIn } : {})}
      {...(props.onPressOut ? { onPressOut: props.onPressOut } : {})}
      style={({ pressed }) => [
        styles.control,
        props.selected || pressed ? styles.controlActive : null,
      ]}
    >
      <Text
        style={[styles.controlLabel, { color: props.textColor ?? color.textPrimary }]}
        maxFontSizeMultiplier={MAX_SCALE}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  center: { textAlign: 'center', paddingHorizontal: 16 },
  stage: { alignItems: 'center', paddingVertical: 4, gap: 4 },
  pad: { paddingHorizontal: 16, paddingBottom: 4 },
  column: {
    flex: 1,
    minHeight: 0,
    marginHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: color.borderSubtle,
  },
  columnHead: { paddingVertical: 6 },
  turns: { flex: 1 },
  turnsBody: { gap: 8, paddingBottom: 8 },
  turn: { gap: 2 },
  filler: { color: color.textTertiary },
  slot: {
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.md,
    padding: 8,
    gap: 4,
    overflow: 'hidden',
  },
  slotEmpty: { opacity: 0.5, justifyContent: 'center', alignItems: 'center' },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  control: {
    minHeight: 44,
    flexGrow: 1,
    flexBasis: '45%',
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlActive: { backgroundColor: color.bgOverlay },
  controlLabel: { ...type.body, fontWeight: '500', textAlign: 'center' },
});
