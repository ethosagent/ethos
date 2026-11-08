// P4 — config parse/write surface. `config-corpus.yaml` has a line for every
// KNOWN_CONFIG_KEYS key and KNOWN_KEY_PREFIXES family; the first test fails when a
// family is added to packages/config without a corpus line.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configParseNotices,
  KNOWN_CONFIG_KEYS,
  KNOWN_KEY_PREFIXES,
  parseConfigYaml,
  resolveEffectiveConfig,
  writeConfig,
} from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertParity, type HermeticEnv, PARITY_DIR, withHermeticEnv } from './harness';

const corpus = readFileSync(join(PARITY_DIR, 'config-corpus.yaml'), 'utf8');

let env: HermeticEnv;
beforeAll(() => {
  env = withHermeticEnv();
  vi.stubEnv('ETHOS_STATE_DIR', '/parity');
});
afterAll(() => env.restore());

describe('P4 config parity', () => {
  it('the corpus covers every known key and key family', () => {
    const lines = corpus
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
      .map((l) => l.slice(0, l.indexOf(':')));
    const missingKeys = KNOWN_CONFIG_KEYS.filter((k) => !lines.includes(k));
    const missingPrefixes = KNOWN_KEY_PREFIXES.filter((p) => !lines.some((l) => l.startsWith(p)));
    expect({ missingKeys, missingPrefixes }).toEqual({ missingKeys: [], missingPrefixes: [] });
  });

  it('parses, writes and re-parses identically to the fixture', async () => {
    const parsed = parseConfigYaml(corpus);
    const storage = new InMemoryStorage();
    await writeConfig(storage, parsed, new InMemorySecretsResolver());
    const written = await storage.read('/parity/config.yaml');
    if (written === null) throw new Error('writeConfig wrote nothing');
    const reparsed = parseConfigYaml(written);
    // The writer normalises what the parse warned about, so the notices are NOT equal to
    // the first parse's; they are pinned in the fixture as `reparsedNotices`.
    // parse -> write -> parse is a fixed point.
    const storage2 = new InMemoryStorage();
    await writeConfig(storage2, reparsed, new InMemorySecretsResolver());
    expect(await storage2.read('/parity/config.yaml')).toBe(written);

    const empty = parseConfigYaml('');
    assertParity('p4-config', {
      parsed,
      notices: configParseNotices(parsed),
      written,
      reparsed,
      reparsedNotices: configParseNotices(reparsed),
      empty,
      emptyNotices: configParseNotices(empty),
      effectiveEmpty: resolveEffectiveConfig(empty, { ETHOS_STATE_DIR: '/parity' }),
    });
  });
});
