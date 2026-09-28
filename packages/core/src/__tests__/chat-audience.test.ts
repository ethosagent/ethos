// plan personality-memory-boundary G1 — `targetAudience`, `isSharedSession`,
// `turnWasShared` and `sessionAudienceStampFor` (packages/core/src/chat-audience.ts). Private only when the id shape PROVES a
// one-to-one chat or the operator listed the room; everything else, including
// ids that cannot be classified, is shared (fail-closed).

import { describe, expect, it } from 'vitest';
import { ROOM_AUDIENCE_METADATA_KEY } from '../agent-loop/audience';
import {
  isSharedSession,
  PERSONALITY_MEMORY_WITHHELD_METADATA_KEY,
  type PrivateChatSet,
  privateChatSetFrom,
  sessionAudienceStampFor,
  targetAudience,
  turnWasShared,
} from '../chat-audience';
import { buildLaneKey } from '../lane-key';

const listed = (platform: string, chatId: string): PrivateChatSet => ({
  has: (p, c) => p === platform && c === chatId,
});

describe('targetAudience', () => {
  it('Telegram: a positive id is a DM, a negative id is a group', () => {
    expect(targetAudience('telegram', '123456')).toBe('private');
    expect(targetAudience('telegram', '-1001234567890')).toBe('shared');
  });

  it('WhatsApp: user JIDs are private; groups, broadcasts and newsletters are shared', () => {
    expect(targetAudience('whatsapp', '15551234567@s.whatsapp.net')).toBe('private');
    expect(targetAudience('whatsapp', '98765@lid')).toBe('private');
    expect(targetAudience('whatsapp', '1203630@g.us')).toBe('shared');
    expect(targetAudience('whatsapp', 'status@broadcast')).toBe('shared');
    expect(targetAudience('whatsapp', '1203@newsletter')).toBe('shared');
  });

  it('Slack: D… ids are DMs; channel and group ids are shared', () => {
    expect(targetAudience('slack', 'D0123ABC')).toBe('private');
    expect(targetAudience('slack', 'C0123ABC')).toBe('shared');
    expect(targetAudience('slack', 'G0123ABC')).toBe('shared');
  });

  it('web targets are private', () => {
    expect(targetAudience('web', 'heartbeat:researcher')).toBe('private');
  });

  it('Discord and email cannot be classified, so they fail closed', () => {
    expect(targetAudience('discord', '112233445566')).toBe('shared');
    expect(targetAudience('email', 'someone@example.com')).toBe('shared');
    expect(targetAudience('unknown-platform', 'x')).toBe('shared');
  });

  it('a listed trusted room is private whatever its shape', () => {
    expect(targetAudience('telegram', '-100', listed('telegram', '-100'))).toBe('private');
    expect(targetAudience('discord', '42', listed('discord', '42'))).toBe('private');
    // Keyed on platform + chat id: the same id on another platform is not listed.
    expect(targetAudience('slack', '-100', listed('telegram', '-100'))).toBe('shared');
  });
});

describe('isSharedSession', () => {
  it('a stamped session is shared whatever its key', () => {
    expect(
      isSharedSession({ key: 'cli:repo', metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'shared' } }),
    ).toBe(true);
  });

  it('pre-upgrade fixture: an unstamped group lane key is shared', () => {
    expect(isSharedSession({ key: buildLaneKey('telegram', 'botkey', '-1001234') })).toBe(true);
    // Threaded, and after `/new` appended a timestamp segment.
    expect(isSharedSession({ key: `${buildLaneKey('slack', 'b', 'C01', '1700.1')}:1712` })).toBe(
      true,
    );
    expect(isSharedSession({ key: buildLaneKey('discord', 'b', '555') })).toBe(true);
  });

  it('an unstamped DM lane key is not shared', () => {
    expect(isSharedSession({ key: buildLaneKey('telegram', 'botkey', '123456') })).toBe(false);
    expect(isSharedSession({ key: buildLaneKey('slack', 'b', 'D01') })).toBe(false);
  });

  it('a trusted room is not shared when the caller passes the list', () => {
    const key = buildLaneKey('telegram', 'botkey', '-100');
    expect(isSharedSession({ key }, listed('telegram', '-100'))).toBe(false);
    expect(isSharedSession({ key })).toBe(true);
  });

  it('a non-channel key is judged by its stamp alone', () => {
    expect(isSharedSession({ key: 'cli:repo' })).toBe(false);
    expect(isSharedSession({ key: 'web:heartbeat:researcher' })).toBe(false);
    expect(isSharedSession({ key: 'acp:peer:session' })).toBe(false);
  });

  it('a channel-platform key with a malformed segment fails closed', () => {
    expect(isSharedSession({ key: 'telegram:bot:%E0%A4%A' })).toBe(true);
  });

  it('verification round B3: a judged private stamp outranks the key shape', () => {
    // A Discord / email DM the gateway judged private at run time.
    const discordDm = {
      key: buildLaneKey('discord', 'b', '555'),
      metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'private' },
    };
    expect(isSharedSession(discordDm)).toBe(false);
    expect(
      isSharedSession({
        key: buildLaneKey('email', 'b', 'a@example.com'),
        metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'private' },
      }),
    ).toBe(false);
  });
});

describe('turnWasShared (verification round B2)', () => {
  const withheld = { [PERSONALITY_MEMORY_WITHHELD_METADATA_KEY]: true };

  it('is isSharedSession OR the D8 withheld marker', () => {
    expect(turnWasShared({ key: buildLaneKey('telegram', 'b', '-100') })).toBe(true);
    expect(turnWasShared({ key: buildLaneKey('telegram', 'b', '42') })).toBe(false);
    // A stranger's Telegram DM: private by key, but a turn withheld memory.
    expect(turnWasShared({ key: buildLaneKey('telegram', 'b', '42'), metadata: withheld })).toBe(
      true,
    );
    // A stranger's Discord DM judged private, with the marker.
    expect(
      turnWasShared({
        key: buildLaneKey('discord', 'b', '555'),
        metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'private', ...withheld },
      }),
    ).toBe(true);
    // The owner's Discord DM judged private: learnable.
    expect(
      turnWasShared({
        key: buildLaneKey('discord', 'b', '555'),
        metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'private' },
      }),
    ).toBe(false);
  });
});

describe('sessionAudienceStampFor', () => {
  const dm = buildLaneKey('discord', 'b', '555');

  it('a shared turn stamps shared (merging), even over a judged private stamp', () => {
    expect(sessionAudienceStampFor('shared', false, { key: 'cli:x', metadata: { a: 1 } })).toEqual({
      a: 1,
      [ROOM_AUDIENCE_METADATA_KEY]: 'shared',
    });
    expect(
      sessionAudienceStampFor('shared', false, {
        key: dm,
        metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'private' },
      }),
    ).toEqual({ [ROOM_AUDIENCE_METADATA_KEY]: 'shared' });
    expect(
      sessionAudienceStampFor('shared', false, {
        key: dm,
        metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'shared' },
      }),
    ).toBeUndefined();
  });

  it('a judged private turn stamps only an unstamped channel-shaped key private', () => {
    expect(sessionAudienceStampFor('private', false, { key: dm }, true)).toEqual({
      [ROOM_AUDIENCE_METADATA_KEY]: 'private',
    });
    // Key shape already private, or not a channel lane: nothing to write.
    expect(
      sessionAudienceStampFor('private', false, { key: buildLaneKey('slack', 'b', 'D1') }, true),
    ).toBeUndefined();
    expect(sessionAudienceStampFor('private', false, { key: 'cli:repo' }, true)).toBeUndefined();
    // Never over a shared stamp (a private turn cannot run on one anyway).
    expect(
      sessionAudienceStampFor(
        'private',
        false,
        { key: dm, metadata: { [ROOM_AUDIENCE_METADATA_KEY]: 'shared' } },
        true,
      ),
    ).toBeUndefined();
  });

  // Verification round E5 — only the gateway judged the room.
  it('an unjudged private turn never writes the private stamp', () => {
    expect(sessionAudienceStampFor('private', false, { key: dm })).toBeUndefined();
    expect(
      sessionAudienceStampFor('private', false, { key: buildLaneKey('telegram', 'b', '-100') }),
    ).toBeUndefined();
  });

  it('a D8 turn adds the withheld marker once', () => {
    expect(
      sessionAudienceStampFor('private', true, { key: buildLaneKey('telegram', 'b', '42') }),
    ).toEqual({ [PERSONALITY_MEMORY_WITHHELD_METADATA_KEY]: true });
    expect(
      sessionAudienceStampFor('private', true, {
        key: buildLaneKey('telegram', 'b', '42'),
        metadata: { [PERSONALITY_MEMORY_WITHHELD_METADATA_KEY]: true },
      }),
    ).toBeUndefined();
  });
});

describe('privateChatSetFrom', () => {
  it('matches exact platform + chat id pairs only', () => {
    const set = privateChatSetFrom({ telegram: ['-1001', '-1002'], slack: ['C0TEAM'] });
    expect(set.has('telegram', '-1001')).toBe(true);
    expect(set.has('telegram', '-1002')).toBe(true);
    expect(set.has('slack', 'C0TEAM')).toBe(true);
    // Same id on another platform, or an id the list does not name.
    expect(set.has('discord', '-1001')).toBe(false);
    expect(set.has('telegram', '-1003')).toBe(false);
    expect(set.has('slack', 'c0team')).toBe(false);
  });

  it('an absent map lists nothing', () => {
    expect(privateChatSetFrom(undefined).has('telegram', '-1001')).toBe(false);
  });

  it('a listed room is private through targetAudience', () => {
    const set = privateChatSetFrom({ telegram: ['-1001'] });
    expect(targetAudience('telegram', '-1001', set)).toBe('private');
    expect(targetAudience('telegram', '-1002', set)).toBe('shared');
  });
});
