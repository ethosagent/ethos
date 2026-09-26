// U11 (openclaw-9.6-gaps) — `notifications.*`: operator quiet hours for
// unprompted channel notices, with an explicit time zone and a per-bot override.
// A setting, not identity, so it lives in config.yaml, never on a personality.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  ethosDir,
  parseConfigYaml,
  parseQuietHoursSpec,
  readRawConfig,
  writeConfig,
} from '../index';

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];
const parse = (...lines: string[]) => parseConfigYaml([...base, ...lines].join('\n'));

describe('notifications.* config', () => {
  it('parses quiet hours, the time zone and a per-bot override', () => {
    const cfg = parse(
      'notifications.quietHours: 22:00-07:00',
      'notifications.timezone: Europe/London',
      'notifications.bots.bot-a.quietHours: off',
      'notifications.bots.bot-b.quietHours: 23:30-06:00',
    );
    expect(cfg.notifications).toEqual({
      quietHours: '22:00-07:00',
      timezone: 'Europe/London',
      bots: { 'bot-a': { quietHours: 'off' }, 'bot-b': { quietHours: '23:30-06:00' } },
    });
  });

  it('the new keys are read — no unknown-key notice for them (U4)', () => {
    const warnings = configParseNotices(
      parse(
        'notifications.quietHours: 22:00-07:00',
        'notifications.timezone: UTC',
        'notifications.bots.bot-a.quietHours: off',
      ),
    ).warnings.join('\n');
    expect(warnings).not.toContain("'notifications.");
  });

  it('a typo in a notifications key is named with its nearest key', () => {
    const warnings = configParseNotices(parse('notifications.quietHour: 22:00-07:00')).warnings;
    expect(warnings.join('\n')).toContain("did you mean 'notifications.quietHours'");
  });

  it('warns on, and drops, a malformed window or an unknown time zone', () => {
    const cfg = parse('notifications.quietHours: late', 'notifications.timezone: Mars/Olympus');
    expect(cfg.notifications).toBeUndefined();
    const warnings = configParseNotices(cfg).warnings.join('\n');
    expect(warnings).toContain('notifications.quietHours');
    expect(warnings).toContain('notifications.timezone');
  });

  it('parseQuietHoursSpec reads HH:MM-HH:MM into minutes after midnight', () => {
    expect(parseQuietHoursSpec('22:00-07:00')).toEqual({ startMinute: 1320, endMinute: 420 });
    expect(parseQuietHoursSpec('9:15-17:45')).toEqual({ startMinute: 555, endMinute: 1065 });
    expect(parseQuietHoursSpec('24:00-07:00')).toBeNull();
    expect(parseQuietHoursSpec('off')).toBeNull();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const notifications = {
      quietHours: '22:00-07:00',
      timezone: 'UTC',
      bots: { 'bot-a': { quietHours: 'off' } },
    };
    await writeConfig(
      storage,
      { provider: 'ollama', model: 'm', apiKey: 'sk', personality: 'p', notifications },
      new InMemorySecretsResolver(),
    );
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toContain(
      'notifications.bots.bot-a.quietHours: off',
    );
    expect((await readRawConfig(storage))?.notifications).toEqual(notifications);
  });
});
