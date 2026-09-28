// plan personality-memory-boundary step 5 — a goal's room audience, derived
// from `Goal.origin` at run time (no column).

import { privateChatSetFrom } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { goalRoomAudience } from '../goal-audience';

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
