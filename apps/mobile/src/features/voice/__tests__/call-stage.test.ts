import { initialVoiceCallState, REDUCED_MOTION_LEVEL } from '@ethosagent/voice-client';
import { describe, expect, it } from 'vitest';
import {
  AX3_FONT_SCALE,
  arcPath,
  CLARIFY_SLOT_HEIGHT,
  callNoticeRows,
  callStageTurns,
  clarifySlotHeight,
  cometSegments,
  hasDismissibleNotice,
  liquidPaths,
  MIC_SETTINGS_PATH,
  orbPath,
  ringGeometry,
  stageFooter,
} from '../call-stage';

describe('stageFooter', () => {
  it('reads provider · model · NNNms once a turn has been heard', () => {
    expect(stageFooter('openai · gpt-realtime', 612)).toBe('openai · gpt-realtime · 612ms');
    expect(stageFooter('openai · gpt-realtime', null)).toBe('openai · gpt-realtime');
    expect(stageFooter('', null)).toBe('');
  });
});

describe('callStageTurns', () => {
  it('labels the live agent line and marks a barge-in', () => {
    const turns = callStageTurns(
      [
        { id: 'voice-0', role: 'user', text: 'hi' },
        { id: 'voice-1', role: 'agent', text: 'Hello there', interrupted: true },
        { id: 'voice-2', role: 'agent', text: 'Still', open: true },
      ],
      'Engineer',
    );
    expect(turns.map((t) => t.label)).toEqual(['You', 'Engineer', 'Engineer · speaking']);
    expect(turns[1]?.text).toContain('[interrupted]');
    expect(turns[2]?.live).toBe(true);
  });
});

describe('callNoticeRows', () => {
  it('says the call is held by a phone call', () => {
    const rows = callNoticeRows(initialVoiceCallState, true);
    expect(rows[0]).toMatchObject({ word: 'held', subject: 'phone call' });
    expect(hasDismissibleNotice(initialVoiceCallState)).toBe(false);
  });

  it('names the fix for a refused mic, and not a second error row', () => {
    const rows = callNoticeRows(
      { ...initialVoiceCallState, micDenied: true, error: 'denied' },
      false,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toContain(MIC_SETTINGS_PATH);
  });

  it('carries the degraded provider and the tier notice', () => {
    const rows = callNoticeRows(
      {
        ...initialVoiceCallState,
        degraded: { provider: 'elevenlabs', message: 'x' },
        error: 'x',
        notice: 'realtime unavailable',
        tier: 'pipeline',
      },
      false,
    );
    expect(rows.map((r) => r.word)).toEqual(['voice', 'tier']);
    expect(rows[0]?.subject).toBe('elevenlabs');
  });
});

describe('clarifySlotHeight', () => {
  it('scales with the text up to AX3 and no further', () => {
    expect(clarifySlotHeight(1)).toBe(CLARIFY_SLOT_HEIGHT);
    expect(clarifySlotHeight(0.8)).toBe(CLARIFY_SLOT_HEIGHT);
    expect(clarifySlotHeight(5)).toBe(Math.round(CLARIFY_SLOT_HEIGHT * AX3_FONT_SCALE));
  });
});

describe('shape geometry', () => {
  const shape = { cx: 100, cy: 100, radius: 60, level: 0.5, phase: 1, reduced: false };

  it('liquid fills higher with level and is a closed path', () => {
    const low = liquidPaths({ ...shape, level: 0 });
    const high = liquidPaths({ ...shape, level: 1 });
    expect(low.fill.endsWith('Z')).toBe(true);
    const firstY = (d: string) => Number(d.split(' L ')[1]?.split(' ')[1]);
    expect(firstY(high.fill)).toBeLessThan(firstY(low.fill));
  });

  it('reduced motion flattens the liquid surface and rounds the orb', () => {
    const flat = liquidPaths({ ...shape, level: REDUCED_MOTION_LEVEL, reduced: true });
    const ys = new Set(
      flat.surface
        .replace('M ', '')
        .split(' L ')
        .map((p) => p.split(' ')[1]),
    );
    expect(ys.size).toBe(1);
    const radii = orbPath({ ...shape, reduced: true })
      .replace(/^M /, '')
      .replace(/ Z$/, '')
      .split(' L ')
      .map((p) => {
        const [x, y] = p.split(' ').map(Number);
        return Math.round(Math.hypot((x ?? 0) - 100, (y ?? 0) - 100));
      });
    expect(new Set(radii).size).toBe(1);
  });

  it('rings breathe outward with level; the comet vanishes under reduced motion', () => {
    expect(ringGeometry(60, 1, false).rings[0]?.r).toBeGreaterThan(
      ringGeometry(60, 0, false).rings[0]?.r ?? 0,
    );
    expect(cometSegments(100, 100, 70, 0, true)).toEqual([]);
    expect(cometSegments(100, 100, 70, 0, false).length).toBeGreaterThan(0);
    expect(arcPath(0, 0, 10, 0, Math.PI / 2)).toMatch(/^M 10\.00 0\.00 A 10\.00 10\.00 0 0 1/);
  });
});
