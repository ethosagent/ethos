// plan personality-memory-boundary step 5 — `cronRunAudience`, the one rule
// every cron runner uses for a firing's room audience (G1-6, D11).

import { privateChatSetFrom } from '@ethosagent/core';
import type { CronJob } from '@ethosagent/cron';
import { describe, expect, it } from 'vitest';
import { cronRunAudience } from '../cron-audience';

function job(overrides: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: overrides.id,
    schedule: '0 8 * * *',
    prompt: 'go',
    personalityId: 'researcher',
    status: 'active',
    missedRunPolicy: 'skip',
    repeat: { kind: 'forever' },
    runCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('cronRunAudience', () => {
  it('a job created in a group chat runs shared', () => {
    const j = job({
      id: 'g',
      roomAudience: 'shared',
      origin: { platform: 'telegram', chatId: '-100200' },
    });
    expect(cronRunAudience(j)).toBe('shared');
  });

  it('a job a shared delegated child created (stamp, no target) runs shared', () => {
    expect(cronRunAudience(job({ id: 'child', roomAudience: 'shared' }))).toBe('shared');
  });

  it('a CLI job (private stamp, no target) runs private', () => {
    expect(cronRunAudience(job({ id: 'c', roomAudience: 'private' }))).toBe('private');
  });

  it('a DM-created job with a DM target runs private', () => {
    const j = job({
      id: 'dm',
      roomAudience: 'private',
      origin: { platform: 'telegram', chatId: '12345' },
    });
    expect(cronRunAudience(j)).toBe('private');
  });

  it('a private-stamped job delivering to a group runs shared (delivery-target rule)', () => {
    const j = job({
      id: 'to-group',
      roomAudience: 'private',
      origin: { platform: 'slack', chatId: 'C0GROUP' },
    });
    expect(cronRunAudience(j)).toBe('shared');
  });

  it('a group target the operator listed in gateway.private_chats is private', () => {
    const j = job({
      id: 'trusted',
      roomAudience: 'private',
      origin: { platform: 'slack', chatId: 'C0GROUP' },
    });
    const privateChats = privateChatSetFrom({ slack: ['C0GROUP'] });
    expect(cronRunAudience(j, { privateChats })).toBe('private');
  });

  it('a listed room does not un-share a job stamped shared', () => {
    const j = job({
      id: 'sticky',
      roomAudience: 'shared',
      origin: { platform: 'slack', chatId: 'C0GROUP' },
    });
    const privateChats = privateChatSetFrom({ slack: ['C0GROUP'] });
    expect(cronRunAudience(j, { privateChats })).toBe('shared');
  });

  it('a contextFrom job that is shared makes the reader shared', () => {
    const source = job({
      id: 'group-digest',
      roomAudience: 'shared',
      origin: { platform: 'telegram', chatId: '-1' },
    });
    const reader = job({ id: 'reader', roomAudience: 'private', contextFrom: ['group-digest'] });
    expect(cronRunAudience(reader, { jobs: [source, reader] })).toBe('shared');
  });

  it('contextFrom resolves by name, only among the same personality, and survives a cycle', () => {
    const foreign = job({
      id: 'x',
      name: 'shared-one',
      roomAudience: 'shared',
      personalityId: 'other',
    });
    const a = job({ id: 'a', roomAudience: 'private', contextFrom: ['b', 'shared-one'] });
    const b = job({ id: 'b', roomAudience: 'private', contextFrom: ['a'] });
    expect(cronRunAudience(a, { jobs: [foreign, a, b] })).toBe('private');
    const own = job({ id: 'y', name: 'shared-one', roomAudience: 'shared' });
    expect(cronRunAudience(a, { jobs: [own, a, b] })).toBe('shared');
  });

  describe('legacy (unstamped) jobs — D11', () => {
    it('a group target runs shared and is reported once', () => {
      const seen: string[] = [];
      const j = job({ id: 'old', origin: { platform: 'telegram', chatId: '-100200' } });
      expect(cronRunAudience(j, { onUnstamped: (l) => seen.push(l.id) })).toBe('shared');
      expect(seen).toEqual(['old']);
    });

    it('a Discord or email target cannot be classified and runs shared', () => {
      expect(cronRunAudience(job({ id: 'd', origin: { platform: 'discord', chatId: '99' } }))).toBe(
        'shared',
      );
      expect(
        cronRunAudience(job({ id: 'e', origin: { platform: 'email', chatId: 'a@b.c' } })),
      ).toBe('shared');
    });

    it('the workaround — listing the chat — makes it private', () => {
      const j = job({ id: 'old', origin: { platform: 'discord', chatId: '99' } });
      const privateChats = privateChatSetFrom({ discord: ['99'] });
      const seen: string[] = [];
      expect(cronRunAudience(j, { privateChats, onUnstamped: (l) => seen.push(l.id) })).toBe(
        'private',
      );
      expect(seen).toEqual([]);
    });

    it('a job with no target (file-only, CLI) runs private', () => {
      expect(cronRunAudience(job({ id: 'file-only' }))).toBe('private');
    });

    it('a web target is private', () => {
      const j = job({ id: 'w', origin: { platform: 'web', chatId: 'web:heartbeat:researcher' } });
      expect(cronRunAudience(j)).toBe('private');
    });
  });
});
