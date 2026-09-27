import {
  CALL_MOTION,
  type CallVisualState,
  markInterrupted,
  type VoiceCallState,
  type VoiceCallStatus,
  type VoiceTranscriptLine,
  waveHeight,
} from '@ethosagent/voice-client';
import type { RowData } from '../../lib/row';

// The Call Stage's pure half (T7): what the stage says and the geometry of the
// shape it draws. The web's stage keeps the same logic beside its canvas
// (`apps/web/src/features/voice/CallStage.tsx`, `TalkMode.tsx`'s
// `STATUS_LABEL`); these mirror it for react-native-svg. HOW the shape moves —
// smoothing, drive, glow, wave — stays in `@ethosagent/voice-client`'s
// call-motion and is not restated here.

/** The mono state word — the web's `STATUS_LABEL`. */
export const STATUS_LABEL: Record<VoiceCallStatus, string> = {
  idle: '',
  connecting: 'connecting',
  reconnecting: 'reconnecting…',
  listening: 'listening',
  thinking: 'thinking',
  consulting: 'consulting',
  agent_speaking: 'speaking',
  interrupted: 'interrupted — go ahead',
  ended: 'call ended',
};

/** Is a call up (the stage should not start another)? */
export function callActive(status: VoiceCallStatus): boolean {
  return status !== 'idle' && status !== 'ended';
}

/** How the shape describes itself to VoiceOver — the web's `stateDescription`. */
export function stateDescription(state: CallVisualState, name: string): string {
  if (state === 'listening') return 'Listening — your microphone is live';
  if (state === 'thinking') return `${name} is thinking`;
  return `${name} is speaking`;
}

export interface CallStageTurn {
  id: string;
  label: string;
  text: string;
  role: 'user' | 'agent';
  live: boolean;
  filler: boolean;
}

/** This call's turns — the web's `callStageTurns`, from the call's own transcript. */
export function callStageTurns(transcript: VoiceTranscriptLine[], name: string): CallStageTurn[] {
  return transcript.map((line) => ({
    id: line.id,
    role: line.role,
    label: line.role === 'user' ? 'You' : line.open ? `${name} · speaking` : name,
    text: line.interrupted ? markInterrupted(line.text) : line.text,
    live: line.role === 'agent' && Boolean(line.open),
    filler: Boolean(line.filler),
  }));
}

/** `provider · model · NNNms` — the footer's mono line. Latency only once a
 *  turn has been heard. */
export function stageFooter(providerLabel: string, totalMs: number | null): string {
  return [providerLabel, totalMs === null ? '' : `${totalMs}ms`].filter(Boolean).join(' · ');
}

/**
 * iOS's AX3 Dynamic Type step as a multiple of the default body size (40 pt /
 * 17 pt): the largest size the stage lays out for (§6a). Text scales up to it
 * and no further.
 */
export const AX3_FONT_SCALE = 40 / 17;

/** The reserved clarify slot's height at the default text size. It scales with
 *  the text (to AX3) but never with its content — filling it moves nothing. */
export const CLARIFY_SLOT_HEIGHT = 168;

/** The slot's height at this text size. */
export function clarifySlotHeight(fontScale: number): number {
  return Math.round(CLARIFY_SLOT_HEIGHT * Math.min(Math.max(fontScale, 1), AX3_FONT_SCALE));
}

/** What iOS Settings calls the fix for a refused mic. */
export const MIC_SETTINGS_PATH = 'Settings → Ethos → Microphone';

/**
 * The stage's status rows, in the one row vocabulary (D7). On the phone the
 * stage stays up for these (the route is left only by the user), so each names
 * what happened and, where there is one, the fix. `held` is not an error: the
 * OS has the audio session (a phone call, Siri) and gives it back by itself.
 */
export function callNoticeRows(
  call: Pick<VoiceCallState, 'degraded' | 'micDenied' | 'notice' | 'error' | 'windDown' | 'tier'>,
  held: boolean,
): RowData[] {
  const rows: RowData[] = [];
  if (held) rows.push({ glyph: '·', word: 'held', subject: 'phone call', result: 'resumes after' });
  if (call.micDenied) {
    rows.push({
      glyph: '✗',
      word: 'mic',
      subject: 'denied',
      result: `allow it: ${MIC_SETTINGS_PATH}`,
    });
  } else if (call.degraded) {
    rows.push({
      glyph: '✗',
      word: 'voice',
      subject: call.degraded.provider ?? 'provider',
      result: 'unavailable — continuing in text',
    });
  } else if (call.error) {
    rows.push({ glyph: '✗', word: 'call', subject: 'error', result: call.error });
  }
  if (call.notice) {
    rows.push({ glyph: '⚠', word: 'tier', subject: call.tier ?? 'pipeline', result: call.notice });
  }
  if (call.windDown) {
    rows.push({ glyph: '·', word: 'budget', subject: 'reached', result: call.windDown });
  }
  return rows;
}

/** Whether a notice can be dismissed (everything but `held`, which clears itself). */
export function hasDismissibleNotice(
  call: Pick<VoiceCallState, 'degraded' | 'micDenied' | 'notice' | 'error' | 'windDown'>,
): boolean {
  return Boolean(call.degraded || call.micDenied || call.notice || call.error || call.windDown);
}

// --- the shape's geometry, for react-native-svg --------------------------

const f = (n: number): string => n.toFixed(2);

/** Liquid: the fill's closed path and its surface line (two summed sines). */
export function liquidPaths(opts: {
  cx: number;
  cy: number;
  radius: number;
  level: number;
  phase: number;
  reduced: boolean;
}): { fill: string; surface: string } {
  const { cx, cy, radius, level, phase, reduced } = opts;
  const fill = 0.18 + CALL_MOTION.travel * 0.72 * level;
  const surfaceY = cy + radius - 2 * radius * fill;
  const wave = waveHeight(radius, level, reduced);
  const at = (x: number): number =>
    surfaceY +
    Math.sin((x / radius) * 3.1 + phase * 1.7) * wave +
    Math.sin((x / radius) * 5.9 - phase * 2.6) * wave * 0.45;
  const step = Math.max(2, radius / 24);
  const points: string[] = [];
  for (let x = -radius; x <= radius; x += step) points.push(`${f(cx + x)} ${f(at(x))}`);
  points.push(`${f(cx + radius)} ${f(at(radius))}`);
  const surface = `M ${points.join(' L ')}`;
  const fillPath = `M ${f(cx - radius)} ${f(cy + radius)} L ${points.join(' L ')} L ${f(cx + radius)} ${f(cy + radius)} Z`;
  return { fill: fillPath, surface };
}

/** Orb: a closed rim that deforms with amplitude; round when reduced. */
export function orbPath(opts: {
  cx: number;
  cy: number;
  radius: number;
  level: number;
  phase: number;
  reduced: boolean;
}): string {
  const { cx, cy, radius, level, phase, reduced } = opts;
  const points = 72;
  const wobble = reduced ? 0 : (0.06 + CALL_MOTION.travel * 0.3) * level;
  const parts: string[] = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const r =
      radius *
      (0.72 + 0.16 * level * CALL_MOTION.travel) *
      (1 +
        wobble * Math.sin(angle * 3 + phase * 1.5) +
        wobble * 0.6 * Math.sin(angle * 5 - phase * 2.1) +
        wobble * 0.35 * Math.sin(angle * 8 + phase * 0.9));
    parts.push(`${f(cx + Math.cos(angle) * r)} ${f(cy + Math.sin(angle) * r)}`);
  }
  return `M ${parts.join(' L ')} Z`;
}

/** Rings: three rings breathing outward from a solid core. */
export function ringGeometry(
  radius: number,
  level: number,
  reduced: boolean,
): { rings: Array<{ r: number; opacity: number }>; core: number } {
  const count = 3;
  const rings: Array<{ r: number; opacity: number }> = [];
  for (let i = count; i >= 1; i--) {
    const spread = reduced ? 0.5 : i / count;
    rings.push({
      r: radius * (0.42 + spread * 0.5 * (0.35 + level * CALL_MOTION.travel)),
      opacity: 0.5 * (1 - (i - 1) / count) + 0.12,
    });
  }
  return { rings, core: radius * (0.36 + 0.07 * level) };
}

/** An SVG arc from angle `from` to `to` (radians) on a circle. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const x1 = cx + Math.cos(from) * r;
  const y1 = cy + Math.sin(from) * r;
  const x2 = cx + Math.cos(to) * r;
  const y2 = cy + Math.sin(to) * r;
  const large = Math.abs(to - from) > Math.PI ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${f(x1)} ${f(y1)} A ${f(r)} ${f(r)} 0 ${large} ${sweep} ${f(x2)} ${f(y2)}`;
}

/** The thinking comet: fading segments trailing `head`. Empty when reduced —
 *  the stage draws a static ring instead. */
export function cometSegments(
  cx: number,
  cy: number,
  r: number,
  head: number,
  reduced: boolean,
): Array<{ d: string; opacity: number }> {
  if (reduced) return [];
  const segments = 14;
  const span = Math.PI * 1.1;
  const out: Array<{ d: string; opacity: number }> = [];
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const to = head - t * span;
    const from = to - span / segments;
    out.push({ d: arcPath(cx, cy, r, from, to), opacity: 0.8 * (1 - t) ** 1.7 });
  }
  return out;
}
