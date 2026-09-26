// Plan openclaw-2026.9.6-gaps U4 (D2 = warn only): a config.yaml line the
// parser never reads is a notice naming the key and the nearest key it does
// read — never an error, and never for a key another reader of the same file
// consumes (EXTERNALLY_READ_CONFIG_KEYS).

import { describe, expect, it } from 'vitest';
import { configParseNotices, parseConfigYaml } from '../index';

const base = ['schemaVersion: 1', 'provider: anthropic', 'model: claude-sonnet-5', 'apiKey: sk'];
const noticesOf = (...lines: string[]) =>
  configParseNotices(parseConfigYaml([...base, ...lines].join('\n')));
const warningsOf = (...lines: string[]) => noticesOf(...lines).warnings;
const unread = (warnings: string[]) => warnings.filter((w) => w.includes('has no effect'));

describe('unknown config keys (U4)', () => {
  it("providers.1.provder: names 'provider' as the key it meant", () => {
    const warnings = warningsOf(
      'providers.0.provider: openai',
      'providers.1.provder: anthropic',
      'providers.1.model: claude-haiku-4',
    );
    expect(warnings.join('\n')).toContain("did you mean 'providers.1.provider'");
  });

  it('an unmodelled field on a kept provider entry is named, with its nearest field', () => {
    const warnings = warningsOf('providers.0.provider: openai', 'providers.0.modle: gpt-5');
    expect(warnings.join('\n')).toContain("'providers.0.modle'");
    expect(warnings.join('\n')).toContain("did you mean 'providers.0.model'");
  });

  it('a top-level typo gets the line-numbered unknown-key warning (B2)', () => {
    // No branch and no known family knows `personalty`, so the U4 notice is
    // replaced by the sharper line-numbered form — one warning per mistake.
    const warnings = warningsOf('personalty: engineer').filter((w) => w.includes('unknown key'));
    expect(warnings).toHaveLength(1);
    // 4 base lines → the typo is line 5.
    expect(warnings[0]).toContain("config.yaml:5 unknown key 'personalty'");
    expect(warnings[0]).toContain("did you mean 'personality'");
  });

  it('a dotted key no branch claims suggests the dotted key it meant', () => {
    const warnings = unread(warningsOf('kanban.maxInProgres: 3'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("did you mean 'kanban.maxInProgress'");
  });

  it('a field a section claims but never reads suggests the field it meant', () => {
    const warnings = unread(warningsOf('display.bell_on_complet: true'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("did you mean 'display.bell_on_complete'");
  });

  it('an indexed bot field suggests the same bot’s field', () => {
    const warnings = unread(
      warningsOf(
        'telegram.bots.0.token: 123:abc',
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: engineer',
        'telegram.bots.0.webhookUrll: https://x.example/tg',
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("did you mean 'telegram.bots.0.webhookUrl'");
  });

  it('a dotted key under a family the parser models is never line-warned (§9)', () => {
    // `plugins.` / `storage.` / `nightlyPass.` / `weeklyDigest.` all have
    // parser branches, so their prefixes belong in KNOWN_KEY_PREFIXES — a
    // deeper key the branch regex does not claim must not read as a typo of
    // some unrelated key.
    const warnings = warningsOf(
      'plugins.marketplace.url: https://plugins.example',
      'nightlyPass.window.start: 02:00',
      'weeklyDigest.sections.top: 5',
      'storage.s3.bucket: ethos-state',
    ).filter((w) => w.includes('unknown key'));
    expect(warnings).toEqual([]);
  });

  it('a key far from every read key is still named, without a guess', () => {
    // A dotted key under NO known family gets the line-numbered form (B2).
    const warnings = warningsOf('zzqx.frobnicate: 1').filter((w) => w.includes('unknown key'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.yaml:5 unknown key 'zzqx.frobnicate'");
    expect(warnings[0]).not.toContain('did you mean');
  });

  it('warns, never errors (D2)', () => {
    expect(noticesOf('personalty: engineer', 'kanban.maxInProgres: 3').errors).toEqual([]);
  });

  it('keys other readers of config.yaml consume are never warned about', () => {
    const warnings = warningsOf(
      // apps/web-api ConfigRepository's `known` set, written by ConfigRepository.write.
      'approvalMode: smart',
      'verbosity: concise',
      'debugMode: true',
      'contextLayering: false',
      // apps/web-api ConfigService: browser voice tuning under display.*.
      'display.voice_chime: false',
      'display.voice_endpoint_silence_ms: 700',
      'display.voice_barge_threshold: 0.4',
      'display.voice_barge_sustain_ms: 200',
      'display.voice_speech_threshold: 0.5',
      'display.voice_speech_min_ms: 150',
      // apps/web-api PlatformsRepository.addTelegramBot.
      'telegram.bots.0.token: 123:abc',
      'telegram.bots.0.bind.type: personality',
      'telegram.bots.0.bind.name: engineer',
      'telegram.bots.0.username: my_bot',
    );
    expect(unread(warnings)).toEqual([]);
  });

  it('read keys, empty values, comments and indented lines are never warned about', () => {
    const warnings = warningsOf(
      '# a comment: with a colon',
      '',
      '  indented: value',
      'voice.trustedPlugins:',
      'security.trusted_github_orgs:',
      'personality: engineer',
      'display.bell_on_complete: true',
      'kanban.maxInProgress: 3',
      'backup.keep: 5',
      'memoryApproval.mode: automated',
      'logs.level: info',
    );
    expect(unread(warnings)).toEqual([]);
  });

  it('discord.approvalRoleIds (S9) is read through the tracked discord map, not warned about', () => {
    const warnings = warningsOf(
      'discord.defaultChannelMode: observe',
      'discord.approvalRoleIds: 111,222',
    );
    expect(unread(warnings)).toEqual([]);
  });

  it('a misspelled discord.approvalRoleIds suggests the real key', () => {
    const warnings = unread(warningsOf('discord.approvalRoleId: 111'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("did you mean 'discord.approvalRoleIds'");
  });

  it('execution.allowLocalFallback (S6 / D3) is read, not warned about', () => {
    const { warnings } = noticesOf('execution.allowLocalFallback: true');
    expect(unread(warnings)).toEqual([]);
    expect(
      parseConfigYaml([...base, 'execution.allowLocalFallback: true'].join('\n')).execution,
    ).toEqual({ allowLocalFallback: true });
  });

  it('a misspelled execution.allowLocalFallback suggests the real key', () => {
    const warnings = unread(warningsOf('execution.allowLocalFalback: true'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("did you mean 'execution.allowLocalFallback'");
  });

  it('storage.encryption (SEC-001) yields only its removal notice, not a generic unknown-key one', () => {
    const warnings = warningsOf('storage.encryption: aes-256-gcm').filter((w) =>
      w.includes('storage.encryption'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'storage.encryption' was removed");
  });
});
