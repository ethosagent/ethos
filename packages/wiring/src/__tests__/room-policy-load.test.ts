// Prompt-file reads and the table loader (plan/phases/channel-prompts.md §3.3, D15;
// channel-prompts-ui §3.1). Normalisation is the gateway's (`buildRoomPolicyTable`,
// extensions/gateway/src/__tests__/room-policy-build.test.ts); this pins the
// Storage side, the injected enums and the CLI listing. Over InMemoryStorage.

import type { ChannelsPlatformConfig, EthosConfig, RawRoomEntry } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeRoomEntries,
  loadRoomPolicies,
  previewRoomPolicyJson,
  readRoomPromptFiles,
  roomEntryVersion,
} from '../room-policy';

const STATE = '/state';
const DIR = `${STATE}/channels`;

let storage: InMemoryStorage;

async function put(platform: string, file: string, body: string): Promise<void> {
  await storage.mkdir(`${DIR}/${platform}`);
  await storage.write(`${DIR}/${platform}/${file}`, body);
}

beforeEach(() => {
  storage = new InMemoryStorage();
});

describe('readRoomPromptFiles', () => {
  it('a missing channels dir is fine: no files, no warnings', async () => {
    expect(await readRoomPromptFiles(storage, STATE)).toEqual({ files: [], warnings: [] });
  });

  it('returns each .md file with platform, base name, path and body', async () => {
    await put('slack', 'C0DEPLOY.md', 'deploy room');
    await put('slack', '_rooms.md', 'any room');
    await put('telegram', '-100123.topics.99.md', 'topic');
    const { files, warnings } = await readRoomPromptFiles(storage, STATE);
    expect(warnings).toEqual([]);
    const byBase = Object.fromEntries(files.map((f) => [`${f.platform}/${f.base}`, f]));
    expect(byBase['slack/C0DEPLOY']).toEqual({
      platform: 'slack',
      base: 'C0DEPLOY',
      path: `${DIR}/slack/C0DEPLOY.md`,
      body: 'deploy room',
    });
    expect(Object.keys(byBase).sort()).toEqual([
      'slack/C0DEPLOY',
      'slack/_rooms',
      'telegram/-100123.topics.99',
    ]);
  });

  it('skips a file over 16 KiB with a warning', async () => {
    await put('slack', 'C1.md', 'x'.repeat(16 * 1024 + 1));
    const { files, warnings } = await readRoomPromptFiles(storage, STATE);
    expect(files).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('C1.md');
    expect(warnings[0]).toContain('16 KiB');
  });

  it('skips on the listing size without reading the file', async () => {
    await put('slack', 'C1.md', 'small');
    const reads: string[] = [];
    const proxy = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === 'listEntries') {
          return async (dir: string) =>
            (await target.listEntries(dir)).map((e) => (e.isDir ? e : { ...e, size: 20_000 }));
        }
        if (prop === 'read') {
          return async (p: string) => {
            reads.push(p);
            return target.read(p);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Storage;
    const { files, warnings } = await readRoomPromptFiles(proxy, STATE);
    expect(files).toEqual([]);
    expect(reads).toEqual([]);
    expect(warnings[0]).toContain('16 KiB');
  });

  it('ignores non-.md files, subdirectories and files outside a platform dir', async () => {
    await put('slack', 'notes.txt', 'nope');
    await put('slack', 'C1.md.bak', 'nope');
    await storage.mkdir(`${DIR}/slack/sub.md`);
    await storage.write(`${DIR}/stray.md`, 'not in a platform dir');
    expect(await readRoomPromptFiles(storage, STATE)).toEqual({ files: [], warnings: [] });
  });
});

const entries = (e: Record<string, RawRoomEntry>): ChannelsPlatformConfig['entries'] =>
  Object.assign(Object.create(null), e);
const cfg = (channels: Record<string, ChannelsPlatformConfig>): EthosConfig =>
  ({ channels }) as unknown as EthosConfig;

describe('loadRoomPolicies (explicit stateDir, injected enums)', () => {
  it('reads files from the given stateDir and merges them with config', async () => {
    await put('slack', 'C2.md', 'file prompt');
    const { table, warnings } = await loadRoomPolicies(
      storage,
      cfg({ slack: { entries: entries({ C1: { prompt: 'inline' } }) } }),
      { stateDir: STATE, modeEnums: {} },
    );
    expect(warnings).toEqual([]);
    expect(table?.slack?.entries.C1?.prompt).toBe('inline');
    expect(table?.slack?.entries.C2?.prompt).toBe('file prompt');
  });

  it('a different stateDir does not see the files', async () => {
    await put('slack', 'C2.md', 'file prompt');
    const { table } = await loadRoomPolicies(storage, cfg({}), {
      stateDir: '/elsewhere',
      modeEnums: {},
    });
    expect(table).toBeUndefined();
  });

  it('modes come from the injected enums: out-of-enum dropped, unknown platform accepted', async () => {
    const { table, warnings } = await loadRoomPolicies(
      storage,
      cfg({
        slack: { entries: entries({ C1: { mode: 'all' }, C2: { mode: 'regex_match' } }) },
        matrix: { entries: entries({ R1: { mode: 'anything' } }) },
      }),
      { stateDir: STATE, modeEnums: { slack: ['mention_only', 'all'] } },
    );
    expect(table?.slack?.entries.C1?.mode).toBe('all');
    expect(table?.slack?.entries.C2?.mode).toBeUndefined();
    expect(warnings.join('\n')).toContain("channels.slack.C2.mode: 'regex_match'");
    expect(table?.matrix?.entries.R1?.mode).toBe('anything');
  });

  it('refuses Telegram regex_match even when the enum lists it', async () => {
    const { table, warnings } = await loadRoomPolicies(
      storage,
      cfg({ telegram: { entries: entries({ '-100': { mode: 'regex_match', prompt: 'p' } }) } }),
      { stateDir: STATE, modeEnums: { telegram: ['mention_only', 'regex_match'] } },
    );
    expect(table?.telegram?.entries['-100']?.mode).toBeUndefined();
    expect(warnings.join('\n')).toContain('needs a pattern');
  });

  it('nothing configured and no files: undefined table', async () => {
    const r = await loadRoomPolicies(storage, cfg({}), { stateDir: STATE, modeEnums: {} });
    expect(r).toEqual({ table: undefined, warnings: [] });
  });
});

describe('describeRoomEntries', () => {
  it('config / file sources; a file is not a source when an inline prompt shadows it', async () => {
    await put('slack', 'C1.md', 'shadowed');
    await put('slack', 'C2.md', 'only file');
    await put('slack', '_rooms.md', 'wild');
    const config = cfg({
      slack: { entries: entries({ C1: { prompt: 'inline', tier: 'deep' }, C3: { silent: true } }) },
    });
    const { table } = await loadRoomPolicies(storage, config, { stateDir: STATE, modeEnums: {} });
    const read = await readRoomPromptFiles(storage, STATE);
    const slack = describeRoomEntries(config, read.files, table ?? {}).slack?.entries ?? [];
    const by = Object.fromEntries(slack.map((r) => [r.selector, r]));
    expect(by.C1).toEqual({ selector: 'C1', fields: ['prompt', 'tier'], sources: ['config'] });
    expect(by.C2?.sources).toEqual([`${DIR}/slack/C2.md`]);
    expect(by['*']?.sources).toEqual([`${DIR}/slack/_rooms.md`]);
    expect(by.C3).toEqual({ selector: 'C3', fields: ['silent'], sources: ['config'] });
  });
});

describe('roomEntryVersion', () => {
  const pairs = [
    ['channels.slack.C1.tier', 'deep'],
    ['channels.slack.C1.silent', 'true'],
  ] as const;
  it('is 8 hex chars and stable', () => {
    expect(roomEntryVersion(pairs, 'body')).toMatch(/^[0-9a-f]{8}$/);
    expect(roomEntryVersion(pairs, 'body')).toBe(roomEntryVersion(pairs, 'body'));
  });
  it('changes on any pair or body change, and null differs from empty', () => {
    const base = roomEntryVersion(pairs, 'body');
    expect(roomEntryVersion([pairs[0], ['channels.slack.C1.silent', 'false']], 'body')).not.toBe(
      base,
    );
    expect(roomEntryVersion([pairs[0]], 'body')).not.toBe(base);
    expect(roomEntryVersion([...pairs, ['channels.slack.C1.mode', 'all']], 'body')).not.toBe(base);
    expect(roomEntryVersion(pairs, 'body2')).not.toBe(base);
    expect(roomEntryVersion(pairs, null)).not.toBe(roomEntryVersion(pairs, ''));
    expect(roomEntryVersion([], null)).not.toBe(roomEntryVersion([], ''));
  });
});

describe('previewRoomPolicyJson', () => {
  it('has the documented key order and values', async () => {
    const config = cfg({
      telegram: {
        entries: entries({
          '-100123': { prompt: 'Parent.' },
          '-100123.topics.7': { prompt: 'Topic.' },
        }),
      },
    });
    const { table } = await loadRoomPolicies(storage, config, { stateDir: STATE, modeEnums: {} });
    const j = previewRoomPolicyJson(
      table ?? {},
      { platform: 'telegram', chatId: '-100123', threadId: '7', isDm: false },
      ['w1'],
    );
    expect(Object.keys(j)).toEqual([
      'ok',
      'platform',
      'chatId',
      'threadId',
      'isDm',
      'roomName',
      'match',
      'fields',
      'promptLayers',
      'digest',
      'block',
      'identityLineOmitted',
      'warnings',
    ]);
    expect(j.match.key).toBe('-100123.topics.7');
    expect(j.block).toBe('Parent.\n\nTopic.');
    expect(j.warnings).toEqual(['w1']);
    expect(j.roomName).toBeNull();
  });
});
