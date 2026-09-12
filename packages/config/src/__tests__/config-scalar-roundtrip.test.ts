// config.yaml values must read back exactly as they were written, whichever
// writer wrote them. `parseConfigScalar` is the one reader of a value;
// `renderConfigScalar` is the CLI writer's rule and `quoteConfigScalar` the one
// quoting both writers use. Inside double quotes exactly two escapes exist,
// `\\` and `\"`; every other backslash is literal, so hand-written Windows
// paths read exactly as they did before any of this. Before this, the reader
// stripped one quote from each end and never unescaped, so every web save of
// `C:\tmp "x"` added another layer of `\`.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  ethosDir,
  loadConfigStrict,
  parseConfigScalar,
  quoteConfigScalar,
  readRawConfig,
  renderConfigScalar,
  writeConfig,
} from '../index';

const TRICKY = [
  'C:\\tmp "x"',
  'C:\\\\server\\share',
  'ends with \\',
  '"quoted"',
  "'single'",
  'it\'s "both"',
  'back\\slash\\',
  'a:b # not-a-comment',
  '  leading and trailing  ',
  'https://example.com/v1?x=1&y=2',
  '#hash-first',
  'plain',
];

describe('parseConfigScalar / renderConfigScalar', () => {
  it.each(TRICKY)('round-trips %j through the CLI spelling', (value) => {
    expect(parseConfigScalar(renderConfigScalar(value))).toBe(value);
  });

  it.each(TRICKY)('round-trips %j through the quoted (web) spelling', (value) => {
    expect(parseConfigScalar(quoteConfigScalar(value))).toBe(value);
  });

  // The web writer used JSON.stringify before this; for a value without control
  // characters that is exactly `\\` and `\"` escaping, so old files still read.
  it.each(TRICKY)('reads %j as the previous (JSON.stringify) web writer wrote it', (value) => {
    expect(parseConfigScalar(JSON.stringify(value))).toBe(value);
  });

  it('leaves an ordinary value unquoted, so existing files keep their shape', () => {
    expect(renderConfigScalar('https://example.com/v1')).toBe('https://example.com/v1');
    expect(renderConfigScalar('0 9 * * *')).toBe('0 9 * * *');
  });

  it('reads the legacy spellings the old stripper accepted', () => {
    expect(parseConfigScalar('"eu-west-1"')).toBe('eu-west-1');
    expect(parseConfigScalar("'eu-west-1'")).toBe('eu-west-1');
    expect(parseConfigScalar("'it''s'")).toBe("it''s");
    expect(parseConfigScalar('  spaced  ')).toBe('spaced');
  });
});

describe('writeConfig round-trips every field', () => {
  it('keeps top-level, chain and unknown chain values byte-identical across writes', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      {
        provider: 'openai-compat',
        model: 'm',
        apiKey: '',
        personality: 'researcher',
        baseUrl: ' http://a"b ',
        providers: [
          {
            provider: 'openai',
            apiKey: '',
            baseUrl: 'C:\\tmp "x"',
            passthrough: { note: '"quoted" and \\back' },
          },
        ],
      },
      secrets,
    );
    const first = await storage.read(join(ethosDir(), 'config.yaml'));
    const cfg = await readRawConfig(storage);
    expect(cfg?.baseUrl).toBe(' http://a"b ');
    expect(cfg?.providers?.[0]?.baseUrl).toBe('C:\\tmp "x"');
    expect(cfg?.providers?.[0]?.passthrough?.note).toBe('"quoted" and \\back');

    if (!cfg) throw new Error('config did not parse');
    await writeConfig(storage, cfg, secrets);
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toBe(first);
  });
});

// Hand-written double-quoted Windows paths read literally — exactly as they
// did before quoting was made reversible. Only `\\` and `\"` are escapes.
describe('hand-written double-quoted values', () => {
  it.each([
    ['"C:\\tmp"', 'C:\\tmp'],
    ['"C:\\Users\\me"', 'C:\\Users\\me'],
    ['"C:\\ffmpeg\\bin"', 'C:\\ffmpeg\\bin'],
    ['"line\\nbreak"', 'line\\nbreak'],
    ['"C:\\\\tmp"', 'C:\\tmp'],
    ['"say \\"hi\\""', 'say "hi"'],
  ])('reads %s as %j', (raw, value) => {
    expect(parseConfigScalar(raw)).toBe(value);
  });

  it('boots with them, reading them literally and without a warning', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      `${['schemaVersion: 1', 'provider: anthropic', 'model: m', 'personality: p', 'baseUrl: "C:\\ffmpeg\\bin"'].join('\n')}\n`,
    );
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.config.baseUrl).toBe('C:\\ffmpeg\\bin');
    expect(loaded?.deprecations).toEqual([]);
  });
});

// The format is line-based: a newline, CR or tab inside a value cannot be
// written so that it reads back. Refused at write time, naming the field.
describe('control characters', () => {
  it.each(['a\nb', 'a\rb', 'a\tb', 'bell\u0007'])('writeConfig refuses %j', async (value) => {
    const storage = new InMemoryStorage();
    const err = await writeConfig(
      storage,
      { provider: 'anthropic', model: 'm', apiKey: '', personality: 'p', baseUrl: value },
      new InMemorySecretsResolver(),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(String((err as { cause?: string }).cause)).toContain("'baseUrl'");
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toBeNull();
  });

  it('a secret with a newline is fine — only its reference reaches the file', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      { provider: 'anthropic', model: 'm', apiKey: 'multi\nline-key', personality: 'p' },
      secrets,
    );
    expect(await secrets.get('providers/anthropic/apiKey')).toBe('multi\nline-key');
  });
});
