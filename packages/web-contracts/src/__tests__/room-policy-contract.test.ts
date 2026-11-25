import { describe, expect, it } from 'vitest';
import {
  contract,
  DeleteRoomPolicyOutputSchema,
  ListRecentRoomsInputSchema,
  ListRecentRoomsOutputSchema,
  ListRoomPoliciesOutputSchema,
  PreviewRoomPolicyInputSchema,
  PreviewRoomPolicyOutputSchema,
  ROOM_MODES,
  RoomEntryFieldsSchema,
  RoomPlatformSchema,
  SetRoomPlatformSettingsInputSchema,
  SetRoomPlatformSettingsOutputSchema,
  SetRoomPolicyInputSchema,
  SetRoomPolicyOutputSchema,
} from '../index';

const entryView = {
  selector: 'C0DEPLOY',
  kind: 'room',
  source: 'both',
  version: '3f9a1c2e',
  fields: { skills: ['deploy-runbook'], tier: 'trivial', mode: 'mention_only', silent: false },
  prompt: {
    text: 'This channel…',
    chars: 87,
    source: 'file',
    path: '~/.ethos/channels/slack/C0DEPLOY.md',
  },
  warnings: [],
} as const;

const setInput = {
  platform: 'slack',
  selector: 'C0DEPLOY',
  expectedVersion: null,
  entry: {
    prompt: 'This channel coordinates production deploys.',
    skills: ['deploy-runbook'],
    tier: 'trivial',
    mode: 'mention_only',
    silent: false,
  },
};

describe('room policy contract: procedures', () => {
  it('registers the six procedures beside the channel filter', () => {
    for (const name of [
      'listRoomPolicies',
      'setRoomPolicy',
      'deleteRoomPolicy',
      'previewRoomPolicy',
      'listRecentRooms',
      'setRoomPlatformSettings',
    ] as const) {
      expect(contract.platforms[name]).toBeDefined();
    }
  });
});

describe('room policy contract: inputs', () => {
  it('accepts the plan example', () => {
    expect(SetRoomPolicyInputSchema.safeParse(setInput).success).toBe(true);
  });

  it('requires expectedVersion (null or string) on set', () => {
    const { expectedVersion: _drop, ...rest } = setInput;
    expect(SetRoomPolicyInputSchema.safeParse(rest).success).toBe(false);
    expect(
      SetRoomPolicyInputSchema.safeParse({ ...setInput, expectedVersion: 'a07b11d4' }).success,
    ).toBe(true);
  });

  it('refuses an empty or over-long selector and an unknown platform', () => {
    expect(SetRoomPolicyInputSchema.safeParse({ ...setInput, selector: '' }).success).toBe(false);
    expect(
      SetRoomPolicyInputSchema.safeParse({ ...setInput, selector: 'x'.repeat(161) }).success,
    ).toBe(false);
    expect(
      SetRoomPolicyInputSchema.safeParse({ ...setInput, selector: 'x'.repeat(160) }).success,
    ).toBe(true);
    expect(SetRoomPolicyInputSchema.safeParse({ ...setInput, platform: 'email' }).success).toBe(
      false,
    );
    expect(RoomPlatformSchema.options).toEqual(['slack', 'discord', 'telegram', 'whatsapp']);
  });

  it('refuses model + tier together, 9 skills and a prompt over 16 KiB chars', () => {
    expect(RoomEntryFieldsSchema.safeParse({ model: 'a/b', tier: 'deep' }).success).toBe(false);
    expect(RoomEntryFieldsSchema.safeParse({ model: 'a/b' }).success).toBe(true);
    expect(
      RoomEntryFieldsSchema.safeParse({ skills: Array.from({ length: 9 }, (_, i) => `s${i}`) })
        .success,
    ).toBe(false);
    expect(
      RoomEntryFieldsSchema.safeParse({ skills: Array.from({ length: 8 }, (_, i) => `s${i}`) })
        .success,
    ).toBe(true);
    expect(RoomEntryFieldsSchema.safeParse({ skills: [''] }).success).toBe(false);
    expect(RoomEntryFieldsSchema.safeParse({ prompt: 'x'.repeat(16_385) }).success).toBe(false);
  });

  it('leaves the 4,000-char cap to the server so it can answer 413, not 400', () => {
    expect(RoomEntryFieldsSchema.safeParse({ prompt: 'x'.repeat(4_213) }).success).toBe(true);
  });

  it('accepts a blank prompt and refuses a malformed mode token', () => {
    expect(RoomEntryFieldsSchema.safeParse({ prompt: '' }).success).toBe(true);
    expect(RoomEntryFieldsSchema.safeParse({ mode: 'Bad-Mode' }).success).toBe(false);
    expect(RoomEntryFieldsSchema.safeParse({ tier: 'huge' }).success).toBe(false);
  });

  it('parses the preview request with an optional draft overlay', () => {
    const base = { platform: 'telegram', chatId: '-1001234567890', threadId: '99', isDm: false };
    expect(PreviewRoomPolicyInputSchema.safeParse(base).success).toBe(true);
    expect(
      PreviewRoomPolicyInputSchema.safeParse({
        ...base,
        draft: { selector: '-1001234567890', entry: { silent: true } },
      }).success,
    ).toBe(true);
    expect(PreviewRoomPolicyInputSchema.safeParse({ ...base, isDm: undefined }).success).toBe(
      false,
    );
  });

  it('bounds listRecentRooms limit to 1..50', () => {
    expect(ListRecentRoomsInputSchema.safeParse({ platform: 'slack' }).success).toBe(true);
    expect(ListRecentRoomsInputSchema.safeParse({ platform: 'slack', limit: 50 }).success).toBe(
      true,
    );
    expect(ListRecentRoomsInputSchema.safeParse({ platform: 'slack', limit: 51 }).success).toBe(
      false,
    );
    expect(ListRecentRoomsInputSchema.safeParse({ platform: 'slack', limit: 0 }).success).toBe(
      false,
    );
  });

  it('takes only a boolean fetchMetadata on the platform setting', () => {
    expect(
      SetRoomPlatformSettingsInputSchema.safeParse({ platform: 'slack', fetchMetadata: true })
        .success,
    ).toBe(true);
    expect(
      SetRoomPlatformSettingsInputSchema.safeParse({ platform: 'slack', fetchMetadata: 'yes' })
        .success,
    ).toBe(false);
    expect(SetRoomPlatformSettingsInputSchema.safeParse({ platform: 'slack' }).success).toBe(false);
  });
});

describe('room policy contract: outputs', () => {
  it('parses the list result', () => {
    expect(
      ListRoomPoliciesOutputSchema.safeParse({
        platform: 'slack',
        allowNameMatching: false,
        fetchMetadata: true,
        modes: [...ROOM_MODES.slack],
        entries: [entryView],
        warnings: [],
      }).success,
    ).toBe(true);
  });

  it('parses set success and the typed partial union', () => {
    expect(
      SetRoomPolicyOutputSchema.safeParse({ ok: true, warnings: [], entry: entryView }).success,
    ).toBe(true);
    expect(
      SetRoomPolicyOutputSchema.safeParse({
        ok: false,
        reason: 'partial',
        fileWritten: true,
        fileRemoved: false,
        configWritten: false,
        cause: 'config.yaml write failed: EACCES',
      }).success,
    ).toBe(true);
    expect(
      SetRoomPolicyOutputSchema.safeParse({
        ok: false,
        reason: 'other',
        fileWritten: true,
        configWritten: false,
        cause: 'x',
      }).success,
    ).toBe(false);
    expect(
      SetRoomPolicyOutputSchema.safeParse({ ok: false, reason: 'partial', cause: 'x' }).success,
    ).toBe(false);
  });

  it('parses delete success and partial', () => {
    expect(DeleteRoomPolicyOutputSchema.safeParse({ ok: true, removed: false }).success).toBe(true);
    expect(
      DeleteRoomPolicyOutputSchema.safeParse({
        ok: false,
        reason: 'partial',
        fileRemoved: true,
        configRemoved: false,
        cause: 'boom',
      }).success,
    ).toBe(true);
    expect(
      DeleteRoomPolicyOutputSchema.safeParse({ ok: false, reason: 'partial', fileWritten: true })
        .success,
    ).toBe(false);
  });

  it('parses the channels-resolve JSON object field for field', () => {
    expect(
      PreviewRoomPolicyOutputSchema.safeParse({
        ok: true,
        platform: 'telegram',
        chatId: '-1001234567890',
        threadId: '99',
        isDm: false,
        roomName: null,
        match: {
          key: '-1001234567890.topics.99',
          source: 'topic',
          layers: ['-1001234567890.topics.99', '-1001234567890'],
        },
        fields: {
          skills: ['incident-template'],
          model: null,
          tier: null,
          identity: true,
          metadata: false,
          silent: false,
          mode: null,
          modeKey: null,
        },
        promptLayers: [
          { key: '-1001234567890', chars: 37 },
          { key: '-1001234567890.topics.99', chars: 44 },
        ],
        digest: '3f9a1c2e',
        block: 'Engineering group…\n\nIncidents topic…',
        identityLineOmitted: true,
        warnings: [],
      }).success,
    ).toBe(true);
  });

  it('parses recent rooms with a nullable isDm', () => {
    expect(
      ListRecentRoomsOutputSchema.safeParse({
        rooms: [
          { chatId: 'C0DEPLOY', isDm: false, lastActiveAt: '2026-11-25T09:12:03Z', hasEntry: true },
          { chatId: 'D0OWNER', isDm: null, lastActiveAt: '2026-11-25T09:00:00Z', hasEntry: false },
        ],
        omittedCount: 0,
      }).success,
    ).toBe(true);
  });

  it('parses the platform-setting union, partial and unsupported included', () => {
    expect(
      SetRoomPlatformSettingsOutputSchema.safeParse({ ok: true, fetchMetadata: true }).success,
    ).toBe(true);
    for (const reason of ['partial', 'unsupported']) {
      expect(
        SetRoomPlatformSettingsOutputSchema.safeParse({ ok: false, reason, cause: 'x' }).success,
      ).toBe(true);
    }
    expect(
      SetRoomPlatformSettingsOutputSchema.safeParse({ ok: false, reason: 'nope', cause: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('ROOM_MODES', () => {
  it('has the per-platform lists (drift vs adapters: apps/web-api room-mode-enum-drift.test.ts)', () => {
    expect(ROOM_MODES.slack).toEqual(['mention_only', 'thread_follow', 'all', 'observe']);
    expect(ROOM_MODES.discord).toEqual(['mention_only', 'thread_follow', 'all', 'observe']);
    expect(ROOM_MODES.telegram).toEqual([
      'mention_only',
      'thread_follow',
      'all',
      'regex_match',
      'observe',
    ]);
    expect(ROOM_MODES.whatsapp).toEqual(['all', 'mention_only', 'observe']);
  });
});
