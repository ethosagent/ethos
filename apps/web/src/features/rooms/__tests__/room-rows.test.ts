// Pure view logic behind Communications > Rooms (plan/phases/channel-prompts-ui.md L5).
// Every decision a row, a chip or the drawer form makes lives in `room-rows.ts`
// so it can be pinned without rendering antd.

import type { RoomEntryView } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  checkRoomId,
  emptyForm,
  entryFromForm,
  formFromEntry,
  PROMPT_LIMIT,
  pinnedLabel,
  previewInputFor,
  promptCounter,
  REGEX_MATCH_REFUSAL,
  ROOM_ID_HINTS,
  ROOM_MODE_DESCRIPTIONS,
  rowChips,
  selectableModes,
  selectorFromForm,
  sourceLabel,
} from '../room-rows';

function view(over: Partial<RoomEntryView> & { selector: string }): RoomEntryView {
  return {
    kind: 'room',
    fields: {},
    prompt: { text: '', chars: 0, source: null, path: null },
    source: 'config',
    version: 'v1',
    warnings: [],
    ...over,
  };
}

describe('buildRows', () => {
  it('always lists the two pinned rows first, labelled per platform', () => {
    const slack = buildRows('slack', []);
    expect(slack.map((r) => [r.selector, r.label, r.pinned])).toEqual([
      ['*', 'All channels', true],
      ['*dm', 'All DMs', true],
    ]);
    expect(buildRows('telegram', [])[0]?.label).toBe('All groups');
    expect(buildRows('whatsapp', [])[0]?.label).toBe('All groups');
    expect(buildRows('discord', [])[0]?.label).toBe('All channels');
    expect(pinnedLabel('discord', '*dm')).toBe('All DMs');
  });

  it('attaches the wildcard entries to the pinned rows, not to the sorted tail', () => {
    const star = view({ selector: '*', kind: 'rooms' });
    const dm = view({ selector: '*dm', kind: 'dms' });
    const rows = buildRows('slack', [view({ selector: 'C2' }), dm, star]);
    expect(rows.map((r) => r.selector)).toEqual(['*', '*dm', 'C2']);
    expect(rows[0]?.entry).toBe(star);
    expect(rows[1]?.entry).toBe(dm);
  });

  it('sorts by selector and nests topics under their room', () => {
    const rows = buildRows('telegram', [
      view({ selector: '-100B' }),
      view({ selector: '-100A.topics.9', kind: 'topic' }),
      view({ selector: '-100A' }),
    ]);
    expect(rows.slice(2).map((r) => [r.selector, r.indent])).toEqual([
      ['-100A', false],
      ['-100A.topics.9', true],
      ['-100B', false],
    ]);
  });

  it('lists a Discord direct thread key as a plain row', () => {
    const rows = buildRows('discord', [view({ selector: '123456789012' })]);
    expect(rows[2]).toMatchObject({ selector: '123456789012', indent: false, pinned: false });
  });
});

describe('rowChips / sourceLabel', () => {
  it('says "not set" for a pinned row with no entry', () => {
    expect(rowChips(null)).toEqual([{ text: 'not set', tone: 'none' }]);
    expect(sourceLabel(null)).toBe('none');
  });

  it('summarises mode, silent, skills and model/tier', () => {
    const chips = rowChips(
      view({
        selector: 'C1',
        fields: { mode: 'thread_follow', silent: true, skills: ['a', 'b'], tier: 'deep' },
      }),
    );
    expect(chips).toEqual([
      { text: 'thread_follow', tone: 'mode' },
      { text: 'silent', tone: 'silent' },
      { text: 'a', tone: 'plain' },
      { text: 'b', tone: 'plain' },
      { text: 'tier: deep', tone: 'plain' },
    ]);
    expect(rowChips(view({ selector: 'C1', fields: { model: 'sonnet-main' } }))).toEqual([
      { text: 'model: sonnet-main', tone: 'plain' },
    ]);
  });

  it('names where the rule lives', () => {
    expect(sourceLabel(view({ selector: 'a', source: 'both' }))).toBe('file + config');
    expect(sourceLabel(view({ selector: 'a', source: 'file' }))).toBe('file');
    expect(sourceLabel(view({ selector: 'a', source: 'config' }))).toBe('config');
  });
});

describe('promptCounter', () => {
  it('formats against the 4,000 limit and flips at 4,001', () => {
    expect(PROMPT_LIMIT).toBe(4000);
    expect(promptCounter(310)).toEqual({ text: '310 / 4,000', over: false, overBy: 0 });
    expect(promptCounter(4000).over).toBe(false);
    expect(promptCounter(4001)).toEqual({ text: '4,001 / 4,000', over: true, overBy: 1 });
  });
});

describe('checkRoomId', () => {
  it('refuses path-unsafe selectors (hard)', () => {
    for (const bad of ['C0/X', 'C0\\X', '../x', '.hidden', 'a b', '_rooms', 'name_x', 'C\u0000X']) {
      expect(checkRoomId('slack', bad).error, bad).toBeTruthy();
    }
    expect(checkRoomId('slack', 'C'.repeat(161)).error).toMatch(/160/);
  });

  it('refuses a colon outside the name: prefix and glob or Windows-illegal characters', () => {
    for (const bad of [
      'C0.prompt:x',
      'C0.skills:y',
      'name:a:b',
      'a*b',
      'a?b',
      'a<b',
      'a|b',
      'a"b',
    ]) {
      expect(checkRoomId('slack', bad).error, bad).toBeTruthy();
    }
    for (const ok of ['*', '*dm', 'name:deploys']) {
      expect(checkRoomId('slack', ok).error, ok).toBeNull();
    }
  });

  it('warns, never refuses, on an unusual but safe id', () => {
    const r = checkRoomId('slack', 'c0deploy');
    expect(r.error).toBeNull();
    expect(r.warning).toMatch(/Slack channel id/);
    expect(checkRoomId('slack', 'C0DEPLOY')).toEqual({ error: null, warning: null });
    expect(checkRoomId('discord', '12345678901234').warning).toBeNull();
    expect(checkRoomId('telegram', '-1001234567890').warning).toBeNull();
    expect(checkRoomId('whatsapp', '120363@g.us').warning).toBeNull();
  });

  it('does not shape-check wildcards or name: selectors', () => {
    expect(checkRoomId('slack', '*')).toEqual({ error: null, warning: null });
    expect(checkRoomId('slack', '*dm')).toEqual({ error: null, warning: null });
    expect(checkRoomId('slack', 'name:deploys').warning).toBeNull();
  });
});

describe('modes and hints', () => {
  it('hides regex_match for Telegram room entries and keeps the rest', () => {
    expect(selectableModes('telegram')).toEqual([
      'mention_only',
      'thread_follow',
      'all',
      'observe',
    ]);
    expect(selectableModes('whatsapp')).toEqual(['all', 'mention_only', 'observe']);
    expect(REGEX_MATCH_REFUSAL).toMatch(/channel-mode/);
  });

  it('has one description per mode and a hint per platform', () => {
    for (const m of ['mention_only', 'thread_follow', 'all', 'observe']) {
      expect(ROOM_MODE_DESCRIPTIONS[m]).toBeTruthy();
    }
    expect(ROOM_ID_HINTS.slack).toMatch(/Channel ID/);
    expect(ROOM_ID_HINTS.discord).toMatch(/Developer Mode/);
    expect(ROOM_ID_HINTS.telegram).toMatch(/-100/);
    expect(ROOM_ID_HINTS.whatsapp).toMatch(/@g\.us/);
  });
});

describe('form <-> entry mapping', () => {
  it('sends a blank prompt as the empty string and omits untouched fields', () => {
    expect(entryFromForm(emptyForm())).toEqual({ prompt: '' });
  });

  it('keeps model and tier mutually exclusive by construction', () => {
    const f = { ...emptyForm(), model: 'tier:deep' };
    expect(entryFromForm(f)).toEqual({ prompt: '', tier: 'deep' });
    expect(entryFromForm({ ...f, model: 'alias:sonnet-main' })).toEqual({
      prompt: '',
      model: 'sonnet-main',
    });
    expect(entryFromForm({ ...f, model: '' })).toEqual({ prompt: '' });
  });

  it('round-trips an entry', () => {
    const e = view({
      selector: 'C1',
      fields: { mode: 'all', skills: ['x'], model: 'm', silent: true, identity: false },
      prompt: { text: 'hello', chars: 5, source: 'file', path: 'p' },
    });
    const form = formFromEntry(e);
    expect(form.prompt).toBe('hello');
    expect(form.model).toBe('alias:m');
    expect(entryFromForm(form)).toEqual({
      prompt: 'hello',
      mode: 'all',
      skills: ['x'],
      model: 'm',
      silent: true,
      identity: false,
    });
  });

  it('builds the selector: topic nests, a Discord thread is the direct key', () => {
    const f = { ...emptyForm(), roomId: '-100A', topicId: '9', threadId: '555' };
    expect(selectorFromForm('telegram', f)).toBe('-100A.topics.9');
    expect(selectorFromForm('discord', f)).toBe('555');
    expect(selectorFromForm('slack', f)).toBe('-100A');
    expect(selectorFromForm('discord', { ...f, threadId: '' })).toBe('-100A');
  });

  it('builds a preview input from the unsaved form', () => {
    const f = { ...emptyForm(), roomId: '-100A', topicId: '9', prompt: 'p' };
    expect(previewInputFor('telegram', f, false)).toEqual({
      platform: 'telegram',
      chatId: '-100A',
      threadId: '9',
      isDm: false,
      draft: { selector: '-100A.topics.9', entry: { prompt: 'p' } },
    });
    const dm = previewInputFor('slack', { ...emptyForm(), roomId: '*dm' }, false);
    expect(dm?.isDm).toBe(true);
    expect(dm?.chatId).not.toBe('*dm');
    expect(previewInputFor('slack', { ...emptyForm(), roomId: '' }, false)).toBeNull();
  });
});
