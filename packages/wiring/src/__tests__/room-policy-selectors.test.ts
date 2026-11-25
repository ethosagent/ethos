// checkRoomSelector (two tiers, plan channel-prompts-ui D15) and roomFileBase, the
// exact inverse of the gateway's roomSelectorFromFile. Pure.

import { roomSelectorFromFile } from '@ethosagent/gateway/room-policy';
import { describe, expect, it } from 'vitest';
import { checkRoomSelector, roomFileBase, roomPromptFilePath } from '../room-policy';

const refused = (platform: string, selector: string, knobs = {}) => {
  const r = checkRoomSelector(platform, selector, knobs);
  expect(r.ok, `${JSON.stringify(selector)} should be refused`).toBe(false);
  return r.ok ? '' : r.reason;
};
const accepted = (platform: string, selector: string, knobs = {}) => {
  const r = checkRoomSelector(platform, selector, knobs);
  if (!r.ok) throw new Error(`${JSON.stringify(selector)} refused: ${r.reason}`);
  return r;
};

describe('checkRoomSelector: hard path-safety refusals (every platform)', () => {
  const unsafe: Array<[string, string]> = [
    ['../x', '..'],
    ['..', '..'],
    ['a..b', '..'],
    ['a/b', '/'],
    ['/abs', '/'],
    ['a\\b', '\\'],
    ['a\0b', 'control'],
    ['a\nb', 'control'],
    ['a\x7fb', 'control'],
    ['a b', 'whitespace'],
    [' C1', 'whitespace'],
    ['.hidden', 'start with'],
    ['_rooms', 'start with'],
    ['_dms', 'start with'],
    ['_x', 'start with'],
    ['name_deploys', 'name_'],
    ['', 'empty'],
    ['x'.repeat(161), '160'],
    ['C0DEPLOY.prompt:pwn', "':'"],
    ['C0.skills:y', "':'"],
    ['a:b', "':'"],
    ['name:a:b', "':'"],
    ['a*b', 'wildcards'],
    ['*dm*', 'wildcards'],
    ['**', 'wildcards'],
    ['a?b', 'wildcards'],
    ['a<b', 'wildcards'],
    ['a>b', 'wildcards'],
    ['a|b', 'wildcards'],
    ['a"b', 'wildcards'],
    ['name:a*b', 'wildcards'],
  ];
  for (const platform of ['slack', 'discord', 'telegram', 'whatsapp', 'someplugin']) {
    it.each(unsafe)(`${platform}: refuses %j`, (selector, fragment) => {
      expect(refused(platform, selector).toLowerCase()).toContain(fragment.toLowerCase());
    });
  }

  it('the exact wildcards and the name: prefix keep their colon and star', () => {
    for (const p of ['slack', 'telegram']) {
      expect(checkRoomSelector(p, '*', {}).ok).toBe(true);
      expect(checkRoomSelector(p, '*dm', {}).ok).toBe(true);
    }
    expect(checkRoomSelector('slack', 'name:deploys', { allowNameMatching: true }).ok).toBe(true);
  });

  it('roomPromptFilePath refuses hostile selectors before they reach a file name', () => {
    for (const s of ['a*b', 'a?b', 'a:b', 'C0.prompt:x', 'name:a:b']) {
      expect(() => roomPromptFilePath('/data', 'slack', s)).toThrow();
    }
  });

  it('accepts exactly 160 characters', () => {
    expect(checkRoomSelector('slack', 'C'.repeat(160), {}).ok).toBe(true);
  });

  it('refuses a platform that is not a safe directory name', () => {
    refused('../etc', 'C1');
    refused('Slack', 'C1');
    refused('', 'C1');
  });
});

describe('checkRoomSelector: wildcards and kinds', () => {
  it('* is rooms, *dm is dms, with no warnings on any platform', () => {
    for (const p of ['slack', 'discord', 'telegram', 'whatsapp', 'plug']) {
      expect(accepted(p, '*')).toMatchObject({ kind: 'rooms', warnings: [] });
      expect(accepted(p, '*dm')).toMatchObject({ kind: 'dms', warnings: [] });
    }
  });
  it('a plain id is kind room; name: is kind name; a topic is kind topic', () => {
    expect(accepted('slack', 'C0DEPLOY').kind).toBe('room');
    expect(accepted('slack', 'name:deploys', { allowNameMatching: true }).kind).toBe('name');
    expect(accepted('telegram', '-100123.topics.99').kind).toBe('topic');
  });
});

describe('checkRoomSelector: per-platform id shape is a warning only (D15)', () => {
  const good: Array<[string, string]> = [
    ['slack', 'C0DEPLOY'],
    ['slack', 'G012AB'],
    ['discord', '123456789012345678'],
    ['telegram', '-1001234567890'],
    ['telegram', '12345'],
    ['whatsapp', '120363025246125486@g.us'],
    ['whatsapp', '15551234567@s.whatsapp.net'],
    ['whatsapp', '1555123456-1600000000@g.us'],
    ['whatsapp', '1234567890123@lid'],
  ];
  it.each(good)('%s %s: no warnings', (platform, selector) => {
    expect(accepted(platform, selector).warnings).toEqual([]);
  });

  const odd: Array<[string, string]> = [
    ['slack', 'c0deploy'],
    ['slack', 'C'],
    ['discord', 'general'],
    ['discord', '123'],
    ['telegram', 'chat'],
    ['whatsapp', '12345'],
  ];
  it.each(odd)('%s %s: accepted with a shape warning naming the id', (platform, selector) => {
    const r = accepted(platform, selector);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(`'${selector}'`);
    expect(r.warnings[0]).toContain('Saved anyway');
  });

  it('a plugin platform has no shape and never warns', () => {
    expect(accepted('matrix', '!abc@server.org').warnings).toEqual([]);
  });
});

describe('checkRoomSelector: topics', () => {
  it('telegram topic: accepted; non-digit sub id warns; room part is shape-checked', () => {
    expect(accepted('telegram', '-100123.topics.99').warnings).toEqual([]);
    expect(accepted('telegram', '-100123.topics.abc').warnings).toHaveLength(1);
    expect(accepted('telegram', 'chat.topics.99').warnings).toHaveLength(1);
  });
  it('telegram topic 1 is refused (the General topic has no thread id)', () => {
    expect(refused('telegram', '-100123.topics.1')).toMatch(/topic 1|General/i);
  });
  it('slack and whatsapp have no topics: refused', () => {
    expect(refused('slack', 'C1.topics.2')).toMatch(/topic/i);
    expect(refused('whatsapp', '12345@g.us.topics.2')).toMatch(/topic/i);
  });
  it('a human-written discord topic is accepted', () => {
    expect(checkRoomSelector('discord', '123456789012345678.topics.5', {}).ok).toBe(true);
  });
  it('a topic with an empty room or sub id is refused', () => {
    refused('telegram', '.topics.5');
    refused('telegram', '-100123.topics.');
  });
});

describe('checkRoomSelector: name: selectors', () => {
  it('refused while allow_name_matching is off or unset', () => {
    expect(refused('slack', 'name:deploys')).toContain('allow_name_matching');
    expect(refused('slack', 'name:deploys', { allowNameMatching: false })).toContain(
      'allow_name_matching',
    );
  });
  it('accepted when matching is on; a non-slug warns with the stored form', () => {
    expect(accepted('slack', 'name:deploys', { allowNameMatching: true }).warnings).toEqual([]);
    const r = accepted('slack', 'name:Deploys', { allowNameMatching: true });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('name:deploys');
  });
  it('a name with no usable slug is refused', () => {
    expect(refused('slack', 'name:', { allowNameMatching: true })).toMatch(/name/);
    expect(refused('slack', 'name:---', { allowNameMatching: true })).toMatch(/name/);
  });
});

describe('checkRoomSelector: case collisions', () => {
  it('warns when an existing selector differs only by case', () => {
    const r = accepted('slack', 'C0DEPLOY', { existingSelectors: ['c0deploy'] });
    expect(r.warnings.join(' ')).toMatch(/differs only by case/);
  });
  it('the identical selector is not a collision', () => {
    expect(accepted('slack', 'C0DEPLOY', { existingSelectors: ['C0DEPLOY'] }).warnings).toEqual([]);
  });
});

describe('roomFileBase', () => {
  it('maps the three special forms and passes everything else through', () => {
    expect(roomFileBase('*')).toBe('_rooms');
    expect(roomFileBase('*dm')).toBe('_dms');
    expect(roomFileBase('name:deploys')).toBe('name_deploys');
    expect(roomFileBase('C0DEPLOY')).toBe('C0DEPLOY');
    expect(roomFileBase('-100123.topics.99')).toBe('-100123.topics.99');
    expect(roomFileBase('120363025246125486@g.us')).toBe('120363025246125486@g.us');
  });

  const forms = [
    '*',
    '*dm',
    'C0DEPLOY',
    '-1001234567890',
    '-1001234567890.topics.99',
    '123456789012345678',
    '123456789012345678.topics.5',
    '120363025246125486@g.us',
    '15551234567@s.whatsapp.net',
    'name:deploys',
    'name:ops-alerts',
    'a.b.c',
    'x@y',
  ];
  it.each(forms)('roomSelectorFromFile(roomFileBase(%s)) round-trips', (selector) => {
    expect(
      checkRoomSelector('plug', selector, { allowNameMatching: true }).ok,
      'fixture must be accepted',
    ).toBe(true);
    expect(roomSelectorFromFile(roomFileBase(selector))).toBe(selector);
  });

  it('every accepted selector round-trips, every non-round-tripping one is refused', () => {
    const candidates = [
      ...forms,
      '_rooms',
      '_dms',
      'name_x',
      'name_',
      '../x',
      'a/b',
      'a\\b',
      'a\0b',
      '_',
      'n',
      'name:',
    ];
    for (const c of candidates) {
      const r = checkRoomSelector('plug', c, { allowNameMatching: true });
      if (r.ok) expect(roomSelectorFromFile(roomFileBase(c))).toBe(c);
    }
  });
});

describe('roomPromptFilePath (join and assert, defence in depth)', () => {
  it('joins under <dataDir>/channels/<platform>/', () => {
    expect(roomPromptFilePath('/data', 'slack', 'C0DEPLOY')).toBe(
      '/data/channels/slack/C0DEPLOY.md',
    );
    expect(roomPromptFilePath('/data', 'slack', '*')).toBe('/data/channels/slack/_rooms.md');
    expect(roomPromptFilePath('/data', 'slack', 'name:ops')).toBe(
      '/data/channels/slack/name_ops.md',
    );
  });
  it.each(['../x', 'a/b', 'a\\b', 'a\0b', '..', '_rooms', 'name_x'])('throws for %j', (sel) => {
    expect(() => roomPromptFilePath('/data', 'slack', sel)).toThrow();
  });
  it('throws for an unsafe platform', () => {
    expect(() => roomPromptFilePath('/data', '../x', 'C1')).toThrow();
  });
});
