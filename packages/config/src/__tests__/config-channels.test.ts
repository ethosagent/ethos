import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  writeConfig,
} from '../index';

// plan channel-prompts §3.2 / L1 — `channels.<platform>.<selector>.<field>`
// per-room entries and the two platform knobs. Parsed into
// `EthosConfig.channels`; warnings, never throws.

const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk',
  'personality: researcher',
];

const parse = (...lines: string[]) => parseConfigYaml([...BASE, ...lines].join('\n'));
const warnings = (cfg: EthosConfig) => configParseNotices(cfg).warnings;

describe('parseConfigYaml — channels.* (§3.2 examples)', () => {
  it('parses the Slack example', () => {
    const cfg = parse(
      'channels.slack.C0DEPLOY.prompt: "This channel coordinates production deploys. Confirm service and environment first."',
      'channels.slack.C0DEPLOY.skills: deploy-runbook, change-freeze',
      'channels.slack.C0DEPLOY.model: sonnet-fast',
      'channels.slack.*.prompt: "You are in a shared team channel. Keep answers short; link, don\'t paste."',
      'channels.slack.*dm.prompt: "This is a private DM with the operator."',
      'channels.slack.allow_name_matching: false',
    );
    expect(cfg.channels?.slack?.entries.C0DEPLOY).toEqual({
      prompt: 'This channel coordinates production deploys. Confirm service and environment first.',
      skills: ['deploy-runbook', 'change-freeze'],
      model: 'sonnet-fast',
    });
    expect(cfg.channels?.slack?.entries['*']?.prompt).toContain('shared team channel');
    expect(cfg.channels?.slack?.entries['*dm']?.prompt).toBe(
      'This is a private DM with the operator.',
    );
    expect(cfg.channels?.slack?.allowNameMatching).toBe(false);
    expect(warnings(cfg)).toEqual([]);
  });

  it('parses the Discord example (nested topics selector and a direct thread key)', () => {
    const cfg = parse(
      'channels.discord.1180000000000000000.prompt: "Support channel. Ask for the order id first."',
      'channels.discord.1180000000000000000.topics.1190000000000000000.tier: trivial',
      'channels.discord.1190000000000000000.prompt: "This thread tracks incident 42."',
    );
    const e = cfg.channels?.discord?.entries ?? {};
    expect(e['1180000000000000000']?.prompt).toBe('Support channel. Ask for the order id first.');
    expect(e['1180000000000000000.topics.1190000000000000000']?.tier).toBe('trivial');
    expect(e['1190000000000000000']?.prompt).toBe('This thread tracks incident 42.');
    expect(warnings(cfg)).toEqual([]);
  });

  it('parses the Telegram example (negative id, .topics. selector, wildcard identity)', () => {
    const cfg = parse(
      'channels.telegram.-1001234567890.prompt: "Engineering group for the Atlas team."',
      'channels.telegram.-1001234567890.topics.99.prompt: "Incidents topic: lead with impact and status."',
      'channels.telegram.-1001234567890.topics.99.skills: incident-template',
      'channels.telegram.*.identity: true',
    );
    const e = cfg.channels?.telegram?.entries ?? {};
    expect(e['-1001234567890']?.prompt).toBe('Engineering group for the Atlas team.');
    expect(e['-1001234567890.topics.99']).toEqual({
      prompt: 'Incidents topic: lead with impact and status.',
      skills: ['incident-template'],
    });
    expect(e['*']?.identity).toBe(true);
    expect(warnings(cfg)).toEqual([]);
  });

  it('parses a WhatsApp @g.us selector', () => {
    const cfg = parse(
      'channels.whatsapp.120363000000000000@g.us.prompt: "Family logistics group. Reply in Hindi when asked in Hindi."',
    );
    expect(cfg.channels?.whatsapp?.entries['120363000000000000@g.us']?.prompt).toBe(
      'Family logistics group. Reply in Hindi when asked in Hindi.',
    );
    expect(warnings(cfg)).toEqual([]);
  });

  it('parses the Email *dm example', () => {
    const cfg = parse(
      'channels.email.*dm.prompt: "You are answering email. Write complete sentences, sign off as the assistant."',
    );
    expect(cfg.channels?.email?.entries['*dm']?.prompt).toContain('answering email');
    expect(warnings(cfg)).toEqual([]);
  });

  it('parses name: selectors, metadata and inherit', () => {
    const cfg = parse(
      'channels.slack.name:deploys.metadata: true',
      'channels.slack.name:deploys.inherit: false',
    );
    expect(cfg.channels?.slack?.entries['name:deploys']).toEqual({
      metadata: true,
      inherit: false,
    });
  });

  it('does not let a prompt value containing ".skills:" re-route the key', () => {
    const cfg = parse('channels.slack.C1.prompt: "use x.skills: y here"');
    expect(cfg.channels?.slack?.entries.C1).toEqual({ prompt: 'use x.skills: y here' });
  });

  it('is absent when no key is set', () => {
    expect(parse().channels).toBeUndefined();
  });
});

describe('parseConfigYaml — channels platform knobs', () => {
  it('parses allow_name_matching and fetch_metadata without making an entry', () => {
    const cfg = parse(
      'channels.slack.allow_name_matching: true',
      'channels.slack.fetch_metadata: true',
    );
    expect(cfg.channels?.slack).toEqual({
      entries: {},
      allowNameMatching: true,
      fetchMetadata: true,
    });
    expect(warnings(cfg)).toEqual([]);
  });

  it('warns on a bad knob boolean and leaves it unset', () => {
    const cfg = parse('channels.slack.fetch_metadata: maybe');
    expect(cfg.channels?.slack?.fetchMetadata).toBeUndefined();
    expect(warnings(cfg).some((w) => w.includes('channels.slack.fetch_metadata'))).toBe(true);
  });
});

describe('parseConfigYaml — channels warnings (never throws)', () => {
  it('warns on an unknown field', () => {
    const cfg = parse('channels.slack.C1.colour: red', 'channels.slack.C1.prompt: hi');
    expect(cfg.channels?.slack?.entries.C1).toEqual({ prompt: 'hi' });
    expect(warnings(cfg).some((w) => w.includes('channels.slack.C1.colour'))).toBe(true);
  });

  it('warns on a bad boolean and drops the field', () => {
    const cfg = parse('channels.slack.C1.identity: yes', 'channels.slack.C1.prompt: hi');
    expect(cfg.channels?.slack?.entries.C1).toEqual({ prompt: 'hi' });
    expect(warnings(cfg).some((w) => w.includes('channels.slack.C1.identity'))).toBe(true);
  });

  it('warns on model + tier together and keeps model', () => {
    const cfg = parse('channels.slack.C1.model: sonnet-fast', 'channels.slack.C1.tier: deep');
    expect(cfg.channels?.slack?.entries.C1).toEqual({ model: 'sonnet-fast' });
    expect(warnings(cfg).some((w) => w.includes('channels.slack.C1') && w.includes('tier'))).toBe(
      true,
    );
  });

  it('warns on an unknown tier and drops it', () => {
    const cfg = parse('channels.slack.C1.tier: turbo', 'channels.slack.C1.prompt: hi');
    expect(cfg.channels?.slack?.entries.C1).toEqual({ prompt: 'hi' });
    expect(warnings(cfg).some((w) => w.includes('turbo'))).toBe(true);
  });

  it('warns on a malformed channels key', () => {
    const cfg = parse('channels.slack: nope');
    expect(cfg.channels).toBeUndefined();
    expect(warnings(cfg).some((w) => w.includes('channels.slack'))).toBe(true);
  });

  it('a __proto__ selector or platform cannot pollute Object.prototype', () => {
    const cfg = parse(
      'channels.slack.__proto__.prompt: polluted',
      'channels.__proto__.C1.prompt: polluted',
      'channels.slack.__proto__.skills: polluted',
    );
    expect(({} as Record<string, unknown>).prompt).toBeUndefined();
    expect(({} as Record<string, unknown>).skills).toBeUndefined();
    expect(Object.hasOwn(cfg.channels?.slack?.entries ?? {}, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(cfg.channels?.slack?.entries ?? {})).toBeNull();
  });
});

describe('parseConfigYaml — channels skills list', () => {
  it('trims and de-duplicates', () => {
    const cfg = parse('channels.slack.C1.skills: a, b ,a,,c');
    expect(cfg.channels?.slack?.entries.C1?.skills).toEqual(['a', 'b', 'c']);
  });
});

describe('parseConfigYaml — channels silent and mode (L11, L12)', () => {
  it('parses silent and mode', () => {
    const cfg = parse(
      'channels.slack.C1.silent: true',
      'channels.slack.C1.mode: mention_only',
      'channels.slack.*dm.silent: false',
    );
    expect(cfg.channels?.slack?.entries.C1).toEqual({ silent: true, mode: 'mention_only' });
    expect(cfg.channels?.slack?.entries['*dm']).toEqual({ silent: false });
    expect(warnings(cfg)).toEqual([]);
  });

  it('warns on a bad silent boolean and drops it', () => {
    const cfg = parse('channels.slack.C1.silent: yes', 'channels.slack.C1.prompt: hi');
    expect(cfg.channels?.slack?.entries.C1).toEqual({ prompt: 'hi' });
    expect(warnings(cfg).some((w) => w.includes('channels.slack.C1.silent'))).toBe(true);
  });

  it.each(['', 'Mention-Only', 'all modes', 'a1'])('warns on a non-token mode %j', (bad) => {
    const cfg = parse(`channels.slack.C1.mode: ${bad}`, 'channels.slack.C1.prompt: hi');
    expect(cfg.channels?.slack?.entries.C1).toEqual({ prompt: 'hi' });
    expect(warnings(cfg).some((w) => w.includes('channels.slack.C1.mode'))).toBe(true);
  });

  it('round-trips through the serializer', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const cfg = parse(
      'channels.slack.C1.silent: true',
      'channels.slack.C1.mode: observe',
      'channels.telegram.*.silent: false',
    );
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const back = await readRawConfig(storage);
    expect(back?.channels).toEqual(cfg.channels);
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toContain(
      'channels.slack.C1.mode: observe',
    );
  });
});

describe('channels — channel_filter is unaffected', () => {
  it('does not turn the sender filter on', () => {
    const cfg = parse('channels.slack.C1.prompt: hi');
    expect(cfg.channelFilter).toBeUndefined();
  });

  it('leaves an explicit channel_filter block alone', () => {
    const cfg = parse('channel_filter.slack.dmPolicy: allowlist', 'channels.slack.C1.prompt: hi');
    expect(cfg.channelFilter?.slack?.dmPolicy).toBe('allowlist');
  });
});

describe('channels — serialize round-trip', () => {
  it('writeConfig → readRawConfig preserves every field', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const cfg = parse(
      'channels.slack.C0DEPLOY.prompt: "Deploys: confirm env first."',
      'channels.slack.C0DEPLOY.skills: a, b',
      'channels.slack.C0DEPLOY.model: sonnet-fast',
      'channels.slack.*dm.identity: false',
      'channels.slack.*dm.tier: deep',
      'channels.slack.allow_name_matching: true',
      'channels.slack.fetch_metadata: false',
      'channels.telegram.-1001.topics.99.metadata: true',
      'channels.telegram.-1001.topics.99.inherit: false',
      'channels.whatsapp.120363000000000000@g.us.prompt: hi',
    );
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const back = await readRawConfig(storage);
    expect(back?.channels).toEqual(cfg.channels);
    expect(back?.channels?.slack?.entries.C0DEPLOY?.prompt).toBe('Deploys: confirm env first.');
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toContain(
      'channels.whatsapp.120363000000000000@g.us.prompt: hi',
    );
  });
});

describe('channels — scalar quoting round-trip', () => {
  const PROMPTS = [
    '"quoted at both ends"',
    '"leading quote only',
    'trailing quote only"',
    "'single'",
    '  leading and trailing spaces  ',
    'has # hash and key: value inside',
    'path C:\\tmp "x"',
  ];

  for (const prompt of PROMPTS) {
    it(`round-trips ${JSON.stringify(prompt)} through writeConfig`, async () => {
      // `channelsToLines` emits the prompt raw on purpose: `serializeConfigLines`
      // runs `renderConfigLine` over every line, so quoting in both places
      // would double-quote. The pair is what must round-trip.
      const storage = new InMemoryStorage();
      await storage.mkdir(ethosDir());
      const cfg = parse();
      cfg.channels = { slack: { entries: { C1: { prompt, skills: ['a', 'b'] } } } };
      await writeConfig(storage, cfg, new InMemorySecretsResolver());
      const back = await readRawConfig(storage);
      expect(back?.channels?.slack?.entries.C1?.prompt).toBe(prompt);
    });
  }
});
