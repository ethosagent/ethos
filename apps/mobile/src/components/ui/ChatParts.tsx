import {
  type ChatMessage,
  decisionRowView,
  formatDuration,
  noticeGlyph,
  statusGlyph,
  statusWord,
  summariseTrail,
  type TrailEntry,
  type TurnPhase,
} from '@ethosagent/chat-state';
import type { ClarifyRequestEvent, DecisionEvent } from '@ethosagent/web-contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, radius, type } from '../../theme/tokens';
import { Button } from './Button';
import { Mark } from './Mark';
import { Row } from './Row';

/** 3 px accent stripe; a `☰` Sessions button at the left edge (44 pt — the
 *  explicit way out of a chat, since the stack header is hidden here), the
 *  mark/name/model row (also opens Sessions), and `+` New session at 44 pt.
 *  No switcher (D5). */
export function PersonalityBar(props: {
  personalityId: string;
  name: string;
  model: string | null;
  accent: string;
  /** Team chat's variant: `marketing · coordinator` after the model. */
  context?: string;
  onOpenSessions: () => void;
  onNew: () => void;
}) {
  return (
    <View style={[styles.bar, { borderTopColor: props.accent }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sessions"
        onPress={props.onOpenSessions}
        style={styles.hamburger}
      >
        <Text style={styles.hamburgerGlyph}>☰</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.name}, open sessions`}
        onPress={props.onOpenSessions}
        style={styles.barMain}
      >
        <Mark personalityId={props.personalityId} size={30} />
        <Text style={type.h4}>{props.name}</Text>
        <Text style={[type.mono, styles.flex]} numberOfLines={1}>
          {[props.model, props.context].filter(Boolean).join(' · ')}
        </Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New session"
        onPress={props.onNew}
        style={styles.plus}
      >
        <View style={[styles.plusButton, { borderColor: props.accent }]}>
          <Text style={[type.h4, { color: props.accent }]}>+</Text>
        </View>
      </Pressable>
    </View>
  );
}

const PHASE_WORD: Record<TurnPhase, string> = {
  received: 'received',
  thinking: 'thinking',
  tool: 'working',
  decision: 'checking',
  writing: 'writing',
};

/** The reserved slot above the composer (feedback contract §2): the phase, or a
 *  resolved row that belongs there (`✗ offline · not sent`). */
export function StatusLine(props: {
  phase: TurnPhase | null;
  label: string | null;
  elapsedMs: number;
  stalled: boolean;
  deciding: boolean;
  accent: string;
}) {
  if (!props.phase && !props.deciding) return <View style={styles.slot} />;
  const text = props.deciding
    ? 'deciding…'
    : props.phase === 'tool'
      ? (props.label ?? 'working')
      : PHASE_WORD[props.phase ?? 'received'];
  return (
    <View style={styles.slot} accessibilityLiveRegion="polite">
      <Text style={{ color: props.accent }}>●</Text>
      <Text style={[type.mono, styles.flex]} numberOfLines={1}>
        {text}
      </Text>
      {props.stalled ? (
        <Text style={[type.mono, { color: color.warning }]}>⚠ still working</Text>
      ) : null}
      <Text style={[type.mono, { color: color.textTertiary }]}>
        {formatDuration(props.elapsedMs)}
      </Text>
    </View>
  );
}

/** `✓ 4 actions · ⚠ 1 unverified · 41.2s ▸` — never a fabricated ✓ (the web's
 *  Trail footer rule: a ✓ needs an ok action and nothing unrecorded or unsettled). */
export function TrailFooter({ entries, stopped }: { entries: TrailEntry[]; stopped: boolean }) {
  const [open, setOpen] = useState(false);
  const s = summariseTrail(entries);
  if (s.actions === 0 && s.findings === 0) return null;
  const count = `${s.actions} ${s.actions === 1 ? 'action' : 'actions'}`;
  const assured = s.ok > 0 && s.unrecorded === 0 && s.unsettled === 0;
  const lead = stopped
    ? `✗ stopped · ${count}`
    : s.failed > 0
      ? `✗ ${count}`
      : assured
        ? `✓ ${count}`
        : count;
  const parts = [
    s.actions > 0 ? lead : null,
    s.findings > 0 ? `⚠ ${s.findings} unverified` : null,
    s.actions > 0 ? (s.totalDurationMs === null ? '—' : formatDuration(s.totalDurationMs)) : null,
  ].filter(Boolean);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={styles.footer}
      >
        <Text style={type.mono}>
          {parts.join(' · ')} {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      {open
        ? entries.map((e) =>
            e.kind === 'action' ? (
              <Row
                key={e.toolCallId}
                row={{
                  glyph: glyphOf(statusGlyph(e.status)),
                  word: statusWord(e.status),
                  subject: e.toolName,
                  result: e.result ?? JSON.stringify(e.args),
                  time: e.durationMs === undefined ? '—' : formatDuration(e.durationMs),
                }}
              />
            ) : e.kind === 'finding' ? (
              <Row
                key={e.id}
                row={{ glyph: '⚠', word: 'unverified', subject: e.claim, result: e.evidence }}
              />
            ) : e.kind === 'decision' ? (
              <DecisionRow key={e.id} event={e.event} />
            ) : (
              <Row
                key={e.id}
                row={{
                  glyph: glyphOf(noticeGlyph(e.tone)),
                  word: e.word,
                  subject: e.subject,
                  result: e.detail,
                }}
              />
            ),
          )
        : null}
    </View>
  );
}

function DecisionRow({ event }: { event: DecisionEvent }) {
  const view = decisionRowView(event);
  return (
    <Row
      row={{
        glyph: glyphOf(view.glyph),
        word: view.word,
        subject: `${view.tag} · ${view.subject}`,
        result: view.detail,
        time: view.duration,
      }}
    />
  );
}

function glyphOf(g: string): '✓' | '✗' | '⚠' | '·' {
  return g === '✓' || g === '✗' || g === '⚠' ? g : '·';
}

/** One message: the user's bubble, or the assistant's content unboxed. Plain
 *  text in this pass; non-text blocks resolve to a row naming what they are. */
export function MessageItem({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userBubble}>
        <Text style={type.body}>{message.content}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      {message.blocks.map((b, i) =>
        b.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only
          <Text key={i} style={type.body} selectable>
            {b.content}
          </Text>
        ) : (
          <Row
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only
            key={i}
            row={{
              glyph: '·',
              word: b.kind,
              subject: 'title' in b ? (b.title ?? '') : '',
              result: 'open on the web',
            }}
          />
        ),
      )}
    </View>
  );
}

/** The agent asked a question (clarify): arrives with no haptic; answering sends
 *  `clarify.respond` and leaves a row. */
export function ClarifyCard(props: {
  request: ClarifyRequestEvent;
  agent: string;
  onAnswer: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState(props.request.default ?? '');
  return (
    <View style={styles.card}>
      <Text style={type.small}>{props.agent} asks · clarify</Text>
      <Text style={type.body}>{props.request.question}</Text>
      <View accessibilityRole="radiogroup">
        {(props.request.options ?? []).map((o) => (
          <Pressable
            key={o}
            accessibilityRole="radio"
            accessibilityState={{ checked: answer === o }}
            onPress={() => setAnswer(o)}
            style={styles.option}
          >
            <Text style={type.body}>
              {answer === o ? '●' : '○'} {o}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={answer}
        onChangeText={setAnswer}
        placeholder="Type an answer"
        placeholderTextColor={color.textTertiary}
        style={[type.body, styles.input]}
      />
      <Button
        label="Answer"
        disabled={!answer.trim()}
        onPress={() => props.onAnswer(answer.trim())}
      />
    </View>
  );
}

/** Bordered composer: the send button in the accent; while a turn runs, text
 *  steers and an empty field offers Stop instead of send. */
export function Composer(props: {
  name: string;
  accent: string;
  streaming: boolean;
  /** Overrides `Message <name>…` at rest (team chat: `Ask <team>…`). */
  placeholder?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const empty = !text.trim();
  const stop = props.streaming && empty;
  return (
    <View style={styles.composer}>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder={
          props.streaming ? 'Steer or interrupt…' : (props.placeholder ?? `Message ${props.name}…`)
        }
        placeholderTextColor={color.textTertiary}
        selectionColor={props.accent}
        style={[type.body, styles.flex]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={stop ? 'Stop' : 'Send'}
        disabled={!stop && empty}
        onPress={() => {
          if (stop) return props.onStop();
          props.onSend(text);
          setText('');
        }}
        style={[styles.send, { backgroundColor: !stop && empty ? color.bgOverlay : props.accent }]}
      >
        <Text style={{ color: color.bgBase, fontWeight: '600' }}>{stop ? '■' : '↑'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bar: {
    height: 50,
    borderTopWidth: 3,
    borderBottomWidth: 1,
    borderBottomColor: color.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 4,
    backgroundColor: color.bgBase,
  },
  barMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, height: '100%' },
  chevron: { color: color.textTertiary, fontSize: 18 },
  hamburger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hamburgerGlyph: { color: color.chrome, fontSize: 18 },
  plus: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  plusButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slot: { height: 28, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
  footer: { minHeight: 28, justifyContent: 'center', paddingVertical: 4 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '75%',
    backgroundColor: color.bgOverlay,
    padding: 12,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 12,
    marginVertical: 6,
  },
  assistant: { marginVertical: 6, gap: 6 },
  card: {
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.md,
    backgroundColor: color.bgElevated,
    padding: 12,
    gap: 8,
    marginVertical: 6,
  },
  option: { minHeight: 44, justifyContent: 'center' },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
  },
  composer: {
    minHeight: 44,
    margin: 12,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgElevated,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  send: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
