// plan personality-memory-boundary step 5 — a goal's room audience, derived
// from `Goal.origin` at run time (no column).

import { privateChatSetFrom } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { goalRoomAudience, goalToolsetExclude } from '../goal-audience';

describe('goalRoomAudience', () => {
  it('web and cli goals are private', () => {
    expect(goalRoomAudience('web')).toBe('private');
    expect(goalRoomAudience('cli')).toBe('private');
  });

  it('a goal set in a group chat runs shared', () => {
    expect(goalRoomAudience('telegram:-100200')).toBe('shared');
    expect(goalRoomAudience('slack:C0GROUP')).toBe('shared');
  });

  it('a goal set in a provable DM runs private', () => {
    expect(goalRoomAudience('telegram:12345')).toBe('private');
    expect(goalRoomAudience('whatsapp:4415550100@s.whatsapp.net')).toBe('private');
  });

  it('splits at the first colon, so a chat id may contain more', () => {
    expect(goalRoomAudience('whatsapp:1203630@g.us')).toBe('shared');
    expect(goalRoomAudience('web:abc:def')).toBe('private');
  });

  it('Discord and email origins cannot be classified and fail closed', () => {
    expect(goalRoomAudience('discord:99')).toBe('shared');
    expect(goalRoomAudience('email:a@b.c')).toBe('shared');
  });

  it('a listed trusted room is private', () => {
    expect(goalRoomAudience('discord:99', privateChatSetFrom({ discord: ['99'] }))).toBe('private');
  });

  it('anything unrecognised is shared', () => {
    expect(goalRoomAudience('')).toBe('shared');
    expect(goalRoomAudience('mystery')).toBe('shared');
  });
});

// A goal turn has no viewer for a card: `emit_card` answers on a channel surface only when the
// turn's `origin` names one (`surfaceOf`, extensions/tools-ui/src/ui-platform.ts), so a goal run
// that carries a channel origin must not be offered the UI tools. `ToolContext` is a frozen
// Tool-contract surface (ARCHITECTURE.md section VII), so the exclusion is made at the run site.
describe('goalToolsetExclude', () => {
  it('excludes the UI card tools for a channel origin', () => {
    expect(goalToolsetExclude('telegram:12345')).toEqual(['emit_card', 'render_ui']);
    expect(goalToolsetExclude('slack:C0GROUP')).toEqual(['emit_card', 'render_ui']);
  });

  it('leaves web and cli goals alone', () => {
    expect(goalToolsetExclude('web')).toBeUndefined();
    expect(goalToolsetExclude('cli')).toBeUndefined();
    expect(goalToolsetExclude(undefined)).toBeUndefined();
  });
});
