import { describe, expect, it } from 'vitest';
import {
  ROOM_SILENT_LINE,
  type RoomPolicyTable,
  renderRoomPrompt,
  resolveRoomPolicy,
  roomModeDefault,
  roomPolicyDigest,
  slugRoomName,
} from '../room-policy';

const dm = { isDm: true } as const;
const room = { isDm: false } as const;

describe('resolveRoomPolicy', () => {
  it('platform absent from the table gives an empty result', () => {
    const r = resolveRoomPolicy({}, { platform: 'slack', chatId: 'C1', ...room });
    expect(r.prompt).toBeUndefined();
    expect(r.matchSource).toBe('none');
    expect(r.matchKey).toBeUndefined();
    expect(r.layers).toEqual([]);
    expect(r.identity).toBe(true);
    expect(r.metadata).toBe(false);
  });

  it('exact match reports key and source', () => {
    const t: RoomPolicyTable = { slack: { entries: { C1: { prompt: 'A', skills: ['s'] } } } };
    const r = resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room });
    expect(r).toMatchObject({ prompt: 'A', skills: ['s'], matchKey: 'C1', matchSource: 'direct' });
    expect(r.layers).toEqual(['C1']);
  });

  it('discord lookup order (D3): direct thread key, then nested topic key, then parent; prompts run parent, topic, thread', () => {
    const t: RoomPolicyTable = {
      discord: {
        entries: {
          P: { prompt: 'parent' },
          'P.topics.T': { prompt: 'topic' },
          T: { prompt: 'thread' },
        },
      },
    };
    const r = resolveRoomPolicy(t, { platform: 'discord', chatId: 'P', threadId: 'T', ...room });
    expect(r.layers).toEqual(['T', 'P.topics.T', 'P']);
    expect(r.prompt).toBe('parent\n\ntopic\n\nthread');
    expect(r.matchKey).toBe('T');
    expect(r.matchSource).toBe('direct');
    expect(r.promptLayers.map((l) => l.key)).toEqual(['P', 'P.topics.T', 'T']);
  });

  it('discord thread direct key alone reports direct', () => {
    const t: RoomPolicyTable = { discord: { entries: { T: { prompt: 'thread' } } } };
    const r = resolveRoomPolicy(t, { platform: 'discord', chatId: 'P', threadId: 'T', ...room });
    expect(r).toMatchObject({ matchKey: 'T', matchSource: 'direct', prompt: 'thread' });
  });

  it('non-discord platforms ignore a direct thread key', () => {
    const t: RoomPolicyTable = { slack: { entries: { T: { prompt: 'x' } } } };
    const r = resolveRoomPolicy(t, { platform: 'slack', chatId: 'C', threadId: 'T', ...room });
    expect(r.matchSource).toBe('none');
  });

  it('nested topic then room: prompt room-first then topic', () => {
    const t: RoomPolicyTable = {
      telegram: { entries: { G: { prompt: 'group' }, 'G.topics.9': { prompt: 'topic' } } },
    };
    const r = resolveRoomPolicy(t, { platform: 'telegram', chatId: 'G', threadId: '9', ...room });
    expect(r.prompt).toBe('group\n\ntopic');
    expect(r.matchSource).toBe('topic');
  });

  it('thread inherits the parent room (source parent)', () => {
    const t: RoomPolicyTable = { slack: { entries: { C1: { prompt: 'A' } } } };
    const r = resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', threadId: '1.2', ...room });
    expect(r).toMatchObject({ prompt: 'A', matchKey: 'C1', matchSource: 'parent' });
  });

  it('wildcard fills fields per field, most specific wins', () => {
    const t: RoomPolicyTable = {
      slack: {
        entries: {
          '*': { prompt: 'W', model: 'wm', tier: 'deep', skills: ['w'], metadata: true },
          C1: { model: 'rm', identity: false },
        },
      },
    };
    const r = resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room });
    expect(r.model).toBe('rm');
    expect(r.tier).toBe('deep');
    expect(r.skills).toEqual(['w']);
    expect(r.identity).toBe(false);
    expect(r.metadata).toBe(true);
    expect(r.prompt).toBe('W');
    expect(r.layers).toEqual(['C1', '*']);
    expect(r.matchKey).toBe('C1');
  });

  it('wildcard prompt is not used when a layer has a prompt', () => {
    const t: RoomPolicyTable = {
      slack: { entries: { '*': { prompt: 'W' }, C1: { prompt: 'A' } } },
    };
    expect(resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room }).prompt).toBe('A');
  });

  it('wildcard only: matchSource wildcard', () => {
    const t: RoomPolicyTable = { slack: { entries: { '*': { prompt: 'W' } } } };
    const r = resolveRoomPolicy(t, { platform: 'slack', chatId: 'Cx', ...room });
    expect(r).toMatchObject({ prompt: 'W', matchKey: '*', matchSource: 'wildcard' });
  });

  it('*dm is separate from *: a DM never uses *, a room never uses *dm', () => {
    const t: RoomPolicyTable = {
      slack: { entries: { '*': { prompt: 'room' }, '*dm': { prompt: 'dm' } } },
    };
    expect(resolveRoomPolicy(t, { platform: 'slack', chatId: 'D1', ...dm }).prompt).toBe('dm');
    expect(resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room }).prompt).toBe('room');
    const onlyStar: RoomPolicyTable = { slack: { entries: { '*': { prompt: 'room' } } } };
    expect(
      resolveRoomPolicy(onlyStar, { platform: 'slack', chatId: 'D1', ...dm }).matchSource,
    ).toBe('none');
    const onlyDm: RoomPolicyTable = { slack: { entries: { '*dm': { prompt: 'dm' } } } };
    expect(
      resolveRoomPolicy(onlyDm, { platform: 'slack', chatId: 'C1', ...room }).matchSource,
    ).toBe('none');
  });

  it('exact DM id beats *dm', () => {
    const t: RoomPolicyTable = {
      slack: { entries: { D1: { prompt: 'exact' }, '*dm': { prompt: 'dm' } } },
    };
    expect(resolveRoomPolicy(t, { platform: 'slack', chatId: 'D1', ...dm }).prompt).toBe('exact');
  });

  it('inherit:false stops the chain and disables wildcard', () => {
    const t: RoomPolicyTable = {
      telegram: {
        entries: {
          '*': { prompt: 'W', model: 'wm' },
          G: { prompt: 'group', model: 'gm' },
          'G.topics.9': { prompt: 'topic', inherit: false },
        },
      },
    };
    const r = resolveRoomPolicy(t, { platform: 'telegram', chatId: 'G', threadId: '9', ...room });
    expect(r.prompt).toBe('topic');
    expect(r.model).toBeUndefined();
    expect(r.layers).toEqual(['G.topics.9']);
  });

  it('inherit:false on the room still reads the more specific layers above it', () => {
    const t: RoomPolicyTable = {
      telegram: {
        entries: {
          '*': { model: 'wm' },
          G: { prompt: 'group', inherit: false },
          'G.topics.9': { tier: 'deep' },
        },
      },
    };
    const r = resolveRoomPolicy(t, { platform: 'telegram', chatId: 'G', threadId: '9', ...room });
    expect(r.prompt).toBe('group');
    expect(r.tier).toBe('deep');
    expect(r.model).toBeUndefined();
    expect(r.layers).toEqual(['G.topics.9', 'G']);
  });

  it('blank prompt is absent', () => {
    const t: RoomPolicyTable = {
      slack: { entries: { '*': { prompt: 'W' }, C1: { prompt: '   \n' } } },
    };
    expect(resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room }).prompt).toBe('W');
    const t2: RoomPolicyTable = { slack: { entries: { C1: { prompt: '  ' } } } };
    expect(
      resolveRoomPolicy(t2, { platform: 'slack', chatId: 'C1', ...room }).prompt,
    ).toBeUndefined();
  });

  it('__proto__ / constructor selectors never match', () => {
    const t: RoomPolicyTable = { slack: { entries: {} } };
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const r = resolveRoomPolicy(t, { platform: 'slack', chatId: id, threadId: id, ...room });
      expect(r.matchSource).toBe('none');
    }
    const r = resolveRoomPolicy({ constructor: { entries: {} } } as RoomPolicyTable, {
      platform: 'toString',
      chatId: 'x',
      ...room,
    });
    expect(r.matchSource).toBe('none');
  });

  it('name matching is off by default', () => {
    const t: RoomPolicyTable = { slack: { entries: { 'name:general': { prompt: 'n' } } } };
    const r = resolveRoomPolicy(t, {
      platform: 'slack',
      chatId: 'C1',
      roomName: 'General',
      ...room,
    });
    expect(r.matchSource).toBe('none');
  });

  it('name matching on: slugged name, source name; id match wins', () => {
    const t: RoomPolicyTable = {
      slack: { allowNameMatching: true, entries: { 'name:dev-ops': { prompt: 'n' } } },
    };
    const r = resolveRoomPolicy(t, {
      platform: 'slack',
      chatId: 'C1',
      roomName: '#Dev Ops!',
      ...room,
    });
    expect(r).toMatchObject({ prompt: 'n', matchKey: 'name:dev-ops', matchSource: 'name' });
    const both: RoomPolicyTable = {
      slack: {
        allowNameMatching: true,
        entries: { 'name:dev-ops': { prompt: 'n' }, C1: { prompt: 'id' } },
      },
    };
    expect(
      resolveRoomPolicy(both, { platform: 'slack', chatId: 'C1', roomName: 'dev ops', ...room })
        .prompt,
    ).toBe('id');
  });

  it('identity defaults true, metadata defaults false, explicit values honoured', () => {
    const t: RoomPolicyTable = { slack: { entries: { C1: { identity: false, metadata: true } } } };
    const r = resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room });
    expect(r.identity).toBe(false);
    expect(r.metadata).toBe(true);
  });

  it('is pure: does not mutate the table', () => {
    const t: RoomPolicyTable = { slack: { entries: { C1: { prompt: 'A', skills: ['x'] } } } };
    const snap = JSON.stringify(t);
    resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room });
    expect(JSON.stringify(t)).toBe(snap);
  });
});

describe('resolveRoomPolicy: silent and mode (L11, L12)', () => {
  const at = (t: RoomPolicyTable, over: Record<string, unknown> = {}) =>
    resolveRoomPolicy(t, { platform: 'slack', chatId: 'C1', ...room, ...over });

  it('defaults: silent false, mode and modeKey undefined', () => {
    const r = at({ slack: { entries: { C1: { prompt: 'A' } } } });
    expect(r.silent).toBe(false);
    expect(r.mode).toBeUndefined();
    expect(r.modeKey).toBeUndefined();
    expect(resolveRoomPolicy({}, { platform: 'slack', chatId: 'C1', ...room }).silent).toBe(false);
  });

  it('a direct entry supplies both, with its selector as modeKey', () => {
    const r = at({ slack: { entries: { C1: { silent: true, mode: 'observe' } } } });
    expect(r).toMatchObject({ silent: true, mode: 'observe', modeKey: 'C1' });
  });

  it('most specific wins: topic beats room beats wildcard, an explicit false counts', () => {
    const t: RoomPolicyTable = {
      telegram: {
        entries: {
          '*': { silent: true, mode: 'all' },
          G: { mode: 'mention_only' },
          'G.topics.9': { silent: false },
        },
      },
    };
    const r = resolveRoomPolicy(t, { platform: 'telegram', chatId: 'G', threadId: '9', ...room });
    expect(r.silent).toBe(false);
    expect(r.mode).toBe('mention_only');
    expect(r.modeKey).toBe('G');
    const other = resolveRoomPolicy(t, { platform: 'telegram', chatId: 'H', ...room });
    expect(other).toMatchObject({ silent: true, mode: 'all', modeKey: '*' });
  });

  it('inherit:false stops the fall-through to the parent and the wildcard', () => {
    const t: RoomPolicyTable = {
      telegram: {
        entries: {
          '*': { silent: true, mode: 'all' },
          G: { silent: true, mode: 'observe' },
          'G.topics.9': { inherit: false, prompt: 'p' },
        },
      },
    };
    const r = resolveRoomPolicy(t, { platform: 'telegram', chatId: 'G', threadId: '9', ...room });
    expect(r.silent).toBe(false);
    expect(r.mode).toBeUndefined();
    expect(r.modeKey).toBeUndefined();
  });

  it('*dm and * are separate: a DM never reads the room wildcard', () => {
    const t: RoomPolicyTable = {
      slack: { entries: { '*': { silent: true, mode: 'observe' }, '*dm': { mode: 'all' } } },
    };
    const d = at(t, { chatId: 'D1', isDm: true });
    expect(d).toMatchObject({ silent: false, mode: 'all', modeKey: '*dm' });
    const g = at(t, { chatId: 'C9' });
    expect(g).toMatchObject({ silent: true, mode: 'observe', modeKey: '*' });
  });
});

describe('roomModeDefault', () => {
  const t: RoomPolicyTable = {
    slack: {
      entries: { '*': { mode: 'mention_only' }, '*dm': { mode: 'all' }, C1: { mode: 'observe' } },
    },
  };
  it('returns the mode and the selector that supplied it', () => {
    expect(roomModeDefault(t, { platform: 'slack', chatId: 'C1', ...room })).toEqual({
      mode: 'observe',
      key: 'C1',
    });
    expect(roomModeDefault(t, { platform: 'slack', chatId: 'C2', ...room })).toEqual({
      mode: 'mention_only',
      key: '*',
    });
    expect(roomModeDefault(t, { platform: 'slack', chatId: 'D', ...dm })).toEqual({
      mode: 'all',
      key: '*dm',
    });
  });
  it('is undefined when nothing sets a mode or the platform is absent', () => {
    expect(roomModeDefault(t, { platform: 'discord', chatId: 'X', ...room })).toBeUndefined();
    expect(
      roomModeDefault(
        { slack: { entries: { C1: { prompt: 'p' } } } },
        {
          platform: 'slack',
          chatId: 'C1',
          ...room,
        },
      ),
    ).toBeUndefined();
  });
});

describe('renderRoomPrompt', () => {
  const base = {
    prompt: undefined,
    identity: true,
    metadata: false,
    matchSource: 'none',
    layers: [],
  } as const;

  it('returns undefined when there is nothing to render, never an empty string', () => {
    expect(renderRoomPrompt({ ...base })).toBeUndefined();
    expect(renderRoomPrompt({ ...base }, { handle: 'bot', isDm: false })).toBeDefined();
    expect(renderRoomPrompt({ ...base }, { handle: '', isDm: false })).toBeUndefined();
    expect(
      renderRoomPrompt({ ...base, identity: false }, { handle: 'bot', isDm: false }),
    ).toBeUndefined();
    expect(renderRoomPrompt({ ...base }, { handle: 'bot', isDm: true })).toBeUndefined();
  });

  it('prompt alone renders verbatim', () => {
    expect(renderRoomPrompt({ ...base, prompt: 'Be terse.' })).toBe('Be terse.');
  });

  it('identity line uses the fixed template, with and without platform id', () => {
    const out = renderRoomPrompt({ ...base }, { handle: 'atlas_bot', isDm: false });
    expect(out).toBe(
      'In this room you are the bot "@atlas_bot". Mentions are routed to you by the gateway, so "@atlas_bot" may have been removed from the text you see. A mention of any other name or id is not a mention of you.',
    );
    const withId = renderRoomPrompt(
      { ...base },
      { handle: 'atlas_bot', platformUserId: 'U123', isDm: false },
    );
    expect(withId).toContain('"@atlas_bot", platform id U123. Mentions');
  });

  it('prompt then identity, joined by a blank line', () => {
    const out = renderRoomPrompt({ ...base, prompt: 'P' }, { handle: 'b', isDm: false });
    expect(out?.startsWith('P\n\nIn this room you are the bot "@b"')).toBe(true);
  });

  it('handle is clamped to 64 chars and stripped to [\\w.\\- ]', () => {
    const out =
      renderRoomPrompt({ ...base }, { handle: `a"b<c>\n${'x'.repeat(100)}`, isDm: false }) ?? '';
    const m = /bot "@([^"]*)"/.exec(out);
    expect(m?.[1]).toBeDefined();
    expect((m?.[1] ?? '').length).toBeLessThanOrEqual(64);
    expect(m?.[1]).toMatch(/^[\w.\- ]*$/);
    expect(out).not.toContain('<c>');
  });

  it('platform id is sanitised too', () => {
    const out =
      renderRoomPrompt({ ...base }, { handle: 'b', platformUserId: 'U1"\n<x>', isDm: false }) ?? '';
    expect(out).not.toContain('<x>');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('silent appends exactly one fixed line, only when silent is true', () => {
    expect(ROOM_SILENT_LINE).toBe('To send nothing in this room, reply with exactly NO_REPLY.');
    expect(renderRoomPrompt({ ...base, silent: true })).toBe(ROOM_SILENT_LINE);
    expect(renderRoomPrompt({ ...base, prompt: 'P', silent: true })).toBe(
      `P\n\n${ROOM_SILENT_LINE}`,
    );
    const withId =
      renderRoomPrompt({ ...base, prompt: 'P', silent: true }, { handle: 'b', isDm: false }) ?? '';
    expect(withId.startsWith('P\n\nIn this room you are the bot "@b"')).toBe(true);
    expect(withId.endsWith(`\n\n${ROOM_SILENT_LINE}`)).toBe(true);
    expect(withId.split(ROOM_SILENT_LINE)).toHaveLength(2);
    expect(renderRoomPrompt({ ...base, prompt: 'P', silent: false })).toBe('P');
    expect(renderRoomPrompt({ ...base, prompt: 'P' })).toBe('P');
  });

  it('is deterministic and carries no per-turn content', () => {
    const a = renderRoomPrompt({ ...base, prompt: 'P' }, { handle: 'b', isDm: false });
    const b = renderRoomPrompt({ ...base, prompt: 'P' }, { handle: 'b', isDm: false });
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('roomPolicyDigest', () => {
  it('is 8 hex chars, stable, and changes with input', () => {
    expect(roomPolicyDigest('a')).toMatch(/^[0-9a-f]{8}$/);
    expect(roomPolicyDigest('a')).toBe(roomPolicyDigest('a'));
    expect(roomPolicyDigest('a')).not.toBe(roomPolicyDigest('b'));
  });
});

describe('slugRoomName', () => {
  it('lowercases, collapses non-alphanumerics to a dash and trims dashes', () => {
    expect(slugRoomName('  #Deploys & Ops!! ')).toBe('deploys-ops');
    expect(slugRoomName('general')).toBe('general');
    expect(slugRoomName('---')).toBe('');
  });

  it('is what name: selectors match against', () => {
    const table: RoomPolicyTable = {
      slack: { allowNameMatching: true, entries: { 'name:deploys-ops': { prompt: 'n' } } },
    };
    const r = resolveRoomPolicy(table, {
      platform: 'slack',
      chatId: 'C9',
      isDm: false,
      roomName: '#Deploys & Ops',
    });
    expect(r.prompt).toBe('n');
    expect(r.matchKey).toBe(`name:${slugRoomName('#Deploys & Ops')}`);
  });
});
