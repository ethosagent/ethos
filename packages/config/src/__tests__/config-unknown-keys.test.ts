// Plan ux-feedback-and-config-clarity B2 (§6.1): a misspelled config key gets
// `config.yaml:<line> unknown key '<k>' — did you mean '<k2>'?`, only when the
// line matched no parser branch AND no known prefix family (§9 false-positive
// rule — `unexpressibleLines`-preserved keys under a known family never warn).
// The drift gate at the bottom pins KNOWN_CONFIG_KEYS / KNOWN_KEY_PREFIXES
// against what `writeConfig` actually emits.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  KNOWN_CONFIG_KEYS,
  KNOWN_KEY_PREFIXES,
  nearestKey,
  parseConfigYaml,
  writeConfig,
} from '../index';

const base = ['schemaVersion: 1', 'provider: anthropic', 'model: claude-sonnet-5', 'apiKey: sk'];
const unknownWarningsOf = (...lines: string[]) =>
  configParseNotices(parseConfigYaml([...base, ...lines].join('\n'))).warnings.filter((w) =>
    w.includes('unknown key'),
  );

describe('unknown-key warnings (B2)', () => {
  it('a top-level typo warns with its line number and the nearest key', () => {
    const warnings = unknownWarningsOf('personalty: engineer');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      "config.yaml:5 unknown key 'personalty' — did you mean 'personality'?",
    );
  });

  it('a dotted typo of a family name warns with a dotted suggestion', () => {
    // `displya.` is not a known family and no branch consumes it; the
    // suggestion comes from the keys the builders actually probed.
    const warnings = unknownWarningsOf('displya.bell_on_complete: true');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.yaml:5 unknown key 'displya.bell_on_complete'");
    expect(warnings[0]).toContain("did you mean 'display.bell_on_complete'");
  });

  it('a key nothing is close to warns without a guess', () => {
    const warnings = unknownWarningsOf('zzqx.frobnicate: 1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe("config.yaml:5 unknown key 'zzqx.frobnicate'");
  });

  it('reports each unknown key once, at its first line', () => {
    const warnings = unknownWarningsOf('personalty: engineer', 'personalty: writer');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('config.yaml:5 ');
  });

  it('never warns for a line under a known family the parser does not model', () => {
    // §9 false-positive rule: these fall through every branch, are preserved
    // verbatim by `unexpressibleLines`, and must not get the unknown-key
    // warning (the softer `has no effect` notice may still apply).
    const warnings = unknownWarningsOf(
      'browser.someFutureKnob: 5',
      'execution.ssh.futureField: x',
      'display.some_next_release_key: on',
      'gateway.notYetModelled: 1',
    );
    expect(warnings).toEqual([]);
  });

  it('never warns for comments, blank lines, or keys other readers consume', () => {
    const warnings = unknownWarningsOf(
      '# a comment: with a colon',
      '',
      'approvalMode: smart',
      'display.voice_chime: false',
    );
    expect(warnings).toEqual([]);
  });

  it('warns, never errors', () => {
    const notices = configParseNotices(parseConfigYaml([...base, 'personalty: x'].join('\n')));
    expect(notices.errors).toEqual([]);
  });
});

describe('nearestKey', () => {
  it('is bounded at Damerau-Levenshtein distance 2 by default', () => {
    expect(nearestKey('personalty', ['personality'])).toBe('personality');
    expect(nearestKey('zzqx', ['personality', 'model'])).toBeUndefined();
  });

  it('counts a transposition as one edit', () => {
    expect(nearestKey('modle', ['model'])).toBe('model');
  });

  it('breaks ties by the shortest candidate', () => {
    // Both are one edit away; the shorter wins whatever the iteration order.
    expect(nearestKey('mode', ['models', 'model'])).toBe('model');
    expect(nearestKey('mode', ['model', 'models'])).toBe('model');
  });
});

// ---------------------------------------------------------------------------
// Drift gate: every key line `writeConfig` can emit is a known key, so a new
// serializer key added without a KNOWN_CONFIG_KEYS / KNOWN_KEY_PREFIXES entry
// fails here instead of warning about itself in the field.
// ---------------------------------------------------------------------------

const FULL_CONFIG: EthosConfig = {
  schemaVersion: 1,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ref, not a template
  apiKey: '${secrets:providers/anthropic/apiKey}',
  personality: 'engineer',
  memory: 'markdown',
  memoryCharLimits: { memory: 20000, user: 8000 },
  execution: {
    allowLocalFallback: true,
    containerized: true,
    docker: { cpu: 2, diskMb: 2048 },
    ssh: { host: 'example.com', user: 'ops', port: 22, remoteWorkdir: '/srv/ethos' },
  },
  baseUrl: 'https://llm.example',
  apiVersion: '2024-06-01',
  region: 'us-east-1',
  awsProfile: 'ethos',
  contextWindow: 200000,
  requestTimeoutMs: 60000,
  approvalTimeoutMs: 30000,
  maxRetries: 3,
  verbose: true,
  displayVerbosity: 'verbose',
  displayToolPreviewLength: 120,
  displayResumeHint: false,
  displayResumeRecapTurns: 3,
  displayBellOnComplete: true,
  displaySlowTurnNoticeMs: 8000,
  displayMemoryNotices: true,
  skin: 'plain',
  retention: { messages: '365d', traces: '30d' },
  activeContext: { type: 'team', name: 'eng' },
  telegram: {
    bots: [
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ref, not a template
        token: '${secrets:telegram/bots/0/token}',
        bind: { type: 'personality', name: 'engineer' },
      },
    ],
  },
  providers: [
    {
      provider: 'openai',
      model: 'gpt-5',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ref, not a template
      apiKey: '${secrets:providers/0/openai/apiKey}',
    },
  ],
  modelRouting: { engineer: 'claude-sonnet-5' },
  cron: { fireUrl: 'http://127.0.0.1:8811/fire', maxParallelJobs: 2 },
  notifications: { quietHours: '22:00-07:00', timezone: 'Europe/London' },
  emailImapHost: 'imap.example.com',
  emailImapPort: 993,
  emailUser: 'bot@example.com',
  emailSmtpHost: 'smtp.example.com',
  emailSmtpPort: 587,
};

describe('known-key drift gate', () => {
  it('every key line writeConfig emits is a known top-level key or under a known family', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, FULL_CONFIG, new InMemorySecretsResolver());
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    if (src === null) throw new Error('config.yaml missing after write');

    const keys = src
      .split('\n')
      .map((line) => {
        const i = line.indexOf(':');
        return i > 0 && !line.startsWith('#') && !/\s/.test(line.slice(0, i))
          ? line.slice(0, i)
          : null;
      })
      .filter((k): k is string => k !== null);
    expect(keys.length).toBeGreaterThan(20);

    const unknown = keys.filter(
      (k) => !KNOWN_CONFIG_KEYS.includes(k) && !KNOWN_KEY_PREFIXES.some((p) => k.startsWith(p)),
    );
    expect(unknown).toEqual([]);

    // And parsing the file back raises no unknown-key warning — the serializer
    // can never warn about its own output.
    const reparsed = parseConfigYaml(src);
    const warnings = configParseNotices(reparsed).warnings.filter((w) => w.includes('unknown key'));
    expect(warnings).toEqual([]);
  });
});
