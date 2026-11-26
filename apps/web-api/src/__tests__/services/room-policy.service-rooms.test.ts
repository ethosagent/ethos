// plan channel-prompts-ui L4 — RoomPolicyService; shared setup in room-policy.service.fixtures.ts.

import { parseChannelsLine } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { ROOM_POLICY_IS_DM_KEY } from '../../../../../extensions/gateway/src/room-turn';
import { buildLaneKey } from '../../../../../packages/core/src/lane-key';
import {
  channelLines,
  failure,
  installRoomPolicyHarness,
  makeSession,
  seed,
  setSessions,
  svc,
} from './room-policy.service.fixtures';

installRoomPolicyHarness();

describe('listRecentRooms', () => {
  const lane = (platform: string, chat: string, thread?: string) =>
    buildLaneKey(platform, 'bot1', chat, ...(thread ? [thread] : []));

  it('decodes the chat id from lane keys, newest first, de-duplicated, rooms only', async () => {
    await seed(['channels.slack.C0DEPLOY.silent: true']);
    setSessions([
      makeSession(lane('slack', 'C0OLD'), 1_000),
      makeSession(lane('slack', 'C0DEPLOY'), 5_000, {
        metadata: { [ROOM_POLICY_IS_DM_KEY]: false },
      }),
      makeSession(lane('slack', 'C0DEPLOY', '1700000000.0001'), 9_000),
      makeSession(`${lane('slack', 'C0DEPLOY')}:1700000000000`, 3_000),
      makeSession(lane('slack', 'D0OWNER'), 7_000, { metadata: { [ROOM_POLICY_IS_DM_KEY]: true } }),
      makeSession(lane('telegram', '-100'), 8_000),
      makeSession('cli:/home/me', 8_500),
    ]);
    const out = await svc.listRecentRooms({ platform: 'slack' });
    expect(out).toEqual({
      rooms: [
        {
          chatId: 'C0DEPLOY',
          isDm: false,
          lastActiveAt: new Date(9_000).toISOString(),
          hasEntry: true,
        },
        {
          chatId: 'D0OWNER',
          isDm: true,
          lastActiveAt: new Date(7_000).toISOString(),
          hasEntry: false,
        },
        {
          chatId: 'C0OLD',
          isDm: null,
          lastActiveAt: new Date(1_000).toISOString(),
          hasEntry: false,
        },
      ],
      omittedCount: 0,
    });
  });

  it('carries no titles, message text or thread ids', async () => {
    setSessions([
      makeSession(lane('slack', 'C0X', '1700000000.0001'), 1_000, {
        title: 'secret roadmap',
        workingDir: '/x',
      }),
    ]);
    const out = await svc.listRecentRooms({ platform: 'slack' });
    expect(JSON.stringify(out)).not.toMatch(/secret|roadmap|1700000000/);
    expect(Object.keys(out.rooms[0] ?? {}).sort()).toEqual([
      'chatId',
      'hasEntry',
      'isDm',
      'lastActiveAt',
    ]);
  });

  it('excludes incognito sessions', async () => {
    setSessions([
      makeSession(lane('slack', 'C0PRIV'), 2_000, {
        metadata: { incognito: true, roomAudience: 'shared' },
      }),
      makeSession(lane('slack', 'C0PUB'), 1_000),
    ]);
    const out = await svc.listRecentRooms({ platform: 'slack' });
    expect(out.rooms.map((r) => r.chatId)).toEqual(['C0PUB']);
  });

  it('honours the limit and reports the rest as omittedCount; the default is 25', async () => {
    setSessions(
      Array.from({ length: 30 }, (_, i) => makeSession(lane('slack', `C${i}`), i * 1000)),
    );
    expect((await svc.listRecentRooms({ platform: 'slack' })).rooms).toHaveLength(25);
    const out = await svc.listRecentRooms({ platform: 'slack', limit: 10 });
    expect(out.rooms).toHaveLength(10);
    expect(out.omittedCount).toBe(20);
    expect(out.rooms[0]?.chatId).toBe('C29');
  });

  it('treats an encoded chat id (WhatsApp) as the id the room entry uses', async () => {
    await seed(['channels.whatsapp.120363000000000000@g.us.silent: true']);
    setSessions([makeSession(lane('whatsapp', '120363000000000000@g.us'), 1_000)]);
    const out = await svc.listRecentRooms({ platform: 'whatsapp' });
    expect(out.rooms[0]).toMatchObject({ chatId: '120363000000000000@g.us', hasEntry: true });
  });
});

describe('the config grammar owner still claims what the service writes', () => {
  it('every line written parses as an entry for its selector', async () => {
    await svc.setRoomPolicy({
      platform: 'telegram',
      selector: '-1001.topics.9',
      entry: {
        skills: ['a', 'b'],
        model: 'm',
        identity: false,
        metadata: false,
        inherit: false,
        silent: true,
        mode: 'all',
      },
      expectedVersion: null,
    });
    for (const l of await channelLines()) {
      const p = parseChannelsLine(l);
      expect(p).toMatchObject({ kind: 'entry', platform: 'telegram', selector: '-1001.topics.9' });
    }
  });

  it('refuses hostile selectors and writes nothing for them', async () => {
    await seed(['channels.slack.C0.prompt: keep me']);
    const before = await channelLines();
    for (const selector of ['C0.prompt:x', 'C0.skills:y', 'name:a:b', 'a*b', 'a?b']) {
      const err = await failure(
        svc.setRoomPolicy({
          platform: 'slack',
          selector,
          entry: { silent: true },
          expectedVersion: null,
        }),
      );
      expect(err.code, selector).toBe('INVALID_INPUT');
    }
    expect(await channelLines()).toEqual(before);
  });
});
