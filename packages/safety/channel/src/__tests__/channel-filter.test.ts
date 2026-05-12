import type { InboundMessage } from '@ethosagent/types';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelPlatformConfig } from '../channel-filter';
import { checkMessage } from '../channel-filter';
import { initPairingDb } from '../pairing-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-42',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    raw: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkMessage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initPairingDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('allowlisted sender in DM → allow', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(msg({ userId: 'user-42', isDm: true }), config, db);
    expect(result.action).toBe('allow');
  });

  it('non-allowlisted DM + pairing policy → pairing_reply with code', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'pairing',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('pairing_reply');
    expect(result.reply).toMatch(/\/allow [A-Z0-9]{8}/);
  });

  it('non-allowlisted DM + allowlist policy → drop', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'allowlist',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('drop');
  });

  it('non-allowlisted group message → drop silently', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: [],
    };
    const result = checkMessage(
      msg({ userId: 'stranger', isDm: false, isGroupMention: true }),
      config,
      db,
    );
    expect(result.action).toBe('drop');
  });

  it('allowlisted group message + no mention → drop (mention gating)', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'user-42', isDm: false, isGroupMention: false }),
      config,
      db,
    );
    expect(result.action).toBe('drop');
  });

  it('allowlisted group message + mention → allow', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'user-42', isDm: false, isGroupMention: true }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
  });

  it('contextVisibility allowlist + reply message → strippedText set', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
      contextVisibility: 'allowlist',
    };
    const result = checkMessage(
      msg({
        userId: 'user-42',
        isDm: true,
        replyToId: 'msg-100',
        replyToUserId: 'attacker-99',
        text: '> quoted\nmy reply',
      }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
    expect(result.strippedText).toBeDefined();
    expect(result.strippedText).toContain('[quoted content from non-allowlisted sender removed]');
  });

  it('contextVisibility allowlist + reply with no replyToUserId → not stripped (unknown sender)', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
      contextVisibility: 'allowlist',
    };
    const result = checkMessage(
      msg({ userId: 'user-42', isDm: true, replyToId: 'msg-100', text: '> quoted\nmy reply' }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
    expect(result.strippedText).toBeUndefined();
  });

  it('contextVisibility allowlist + reply from allowlisted sender → not stripped', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42', 'trusted-user'],
      contextVisibility: 'allowlist',
    };
    const result = checkMessage(
      msg({
        userId: 'user-42',
        isDm: true,
        replyToId: 'msg-200',
        replyToUserId: 'trusted-user',
        text: '> trusted content\nmy reply',
      }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
    expect(result.strippedText).toBeUndefined();
  });

  it('owner in group without mention bypasses mention gate', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'owner-1', isDm: false, isGroupMention: false }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
  });

  it('email glob *@domain.com matches user@domain.com', () => {
    const result = checkMessage(
      msg({ userId: 'alice@myteam.com', isDm: true, platform: 'email' }),
      { recipientAllowlist: ['*@myteam.com'], dmPolicy: 'allowlist' },
      db,
    );
    expect(result.action).toBe('allow');
  });

  it('email glob *@domain.com does not match user@other.com', () => {
    const result = checkMessage(
      msg({ userId: 'alice@other.com', isDm: true, platform: 'email' }),
      { recipientAllowlist: ['*@myteam.com'], dmPolicy: 'allowlist' },
      db,
    );
    expect(result.action).toBe('drop');
  });

  it('no platform config → allow (backward compat)', () => {
    const result = checkMessage(msg(), undefined, db);
    expect(result.action).toBe('allow');
  });

  it('owner userId is always allowed', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-special',
      recipientAllowlist: [],
      dmPolicy: 'allowlist',
    };
    const result = checkMessage(msg({ userId: 'owner-special', isDm: true }), config, db);
    expect(result.action).toBe('allow');
  });

  it('non-allowlisted DM + reject policy → drop', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'reject',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('drop');
  });

  it('non-allowlisted DM + silent-drop policy → drop', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'silent-drop',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('drop');
  });
});
