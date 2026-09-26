// B2 (plan ux-feedback-and-config-clarity §4) — the default `ethos` command
// prints each config parse warning once per process, before the welcome line.

import { parseConfigYaml } from '@ethosagent/config';
import { afterEach, describe, expect, it } from 'vitest';
import { configWarningLinesOnce, resetConfigWarningsForTest } from '../lib/config-warnings';

afterEach(() => resetConfigWarningsForTest());

const src = [
  'schemaVersion: 1',
  'provider: anthropic',
  'model: claude-sonnet-5',
  'apiKey: sk',
  'personalty: engineer',
].join('\n');

describe('chat config warnings (B2)', () => {
  it('surfaces the unknown-key warning with line number and suggestion', () => {
    const lines = configWarningLinesOnce(parseConfigYaml(src));
    expect(lines).toContain("config.yaml:5 unknown key 'personalty' — did you mean 'personality'?");
  });

  it('prints once per process — a second call returns nothing', () => {
    const config = parseConfigYaml(src);
    expect(configWarningLinesOnce(config).length).toBeGreaterThan(0);
    expect(configWarningLinesOnce(config)).toEqual([]);
  });

  it('a clean config yields no lines (and still latches)', () => {
    const clean = parseConfigYaml(src.split('\n').slice(0, 4).join('\n'));
    expect(configWarningLinesOnce(clean)).toEqual([]);
  });
});
