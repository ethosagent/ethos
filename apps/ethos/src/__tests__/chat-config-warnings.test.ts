// B2 (plan ux-feedback-and-config-clarity §4) — the default `ethos` command
// prints each config parse warning once per process, before the welcome line.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adoptConfigNotices, parseConfigYaml } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCliOverrides } from '../cli-overrides';
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

  // Regression: warnings are keyed by the parsed config OBJECT's identity, and
  // the chat path routes through `{ ...config }` in index.ts plus the clone in
  // applyCliOverrides — either copy silently dropped every line until
  // adoptConfigNotices carried the side-tables across. Drive the REAL plumbing
  // index.ts uses, with and without override flags.
  it('warnings survive applyCliOverrides with no flags (identity-preserving fast path)', async () => {
    const parsed = parseConfigYaml(src);
    const result = await applyCliOverrides(parsed, {}, new InMemoryStorage());
    expect(configWarningLinesOnce(result)).toContain(
      "config.yaml:5 unknown key 'personalty' — did you mean 'personality'?",
    );
  });

  it('warnings survive applyCliOverrides when an override flag clones the config', async () => {
    const parsed = parseConfigYaml(src);
    const result = await applyCliOverrides(parsed, { model: 'claude-foo' }, new InMemoryStorage());
    expect(result).not.toBe(parsed);
    expect(result.model).toBe('claude-foo');
    expect(configWarningLinesOnce(result)).toContain(
      "config.yaml:5 unknown key 'personalty' — did you mean 'personality'?",
    );
  });

  it("warnings survive index.ts's own pre-override spread when adopted", async () => {
    // The default-command path in index.ts clones before applyCliOverrides
    // (`let withFlags = { ...config }` + adoptConfigNotices). Reproduce that
    // exact sequence end to end.
    const parsed = parseConfigYaml(src);
    const withFlags = { ...parsed };
    adoptConfigNotices(withFlags, parsed);
    const result = await applyCliOverrides(
      withFlags,
      { model: 'claude-foo' },
      new InMemoryStorage(),
    );
    expect(configWarningLinesOnce(result)).toContain(
      "config.yaml:5 unknown key 'personalty' — did you mean 'personality'?",
    );
  });

  it('index.ts adopts the notices onto both of its pre-override clones', () => {
    // Same source-pin style as the runTUI case below: the two
    // `let withFlags = { ... }` spreads on the chat path must each be followed
    // by an adoptConfigNotices call, or the WeakMap-keyed warnings are shed
    // before runChat ever sees the config.
    const indexSrc = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8');
    expect(indexSrc.match(/adoptConfigNotices\(withFlags, (fresh|config)\);/g)).toHaveLength(2);
  });

  it('the TUI branch hands the same lines to runTUI as startupNotices', () => {
    // runChat is not exported piecemeal (it needs a TTY + live runtime), so
    // pin the wiring at the source, the same way tui-capabilities.test.ts pins
    // CLI_SLASH_SENDER: the one runTUI call chat.ts makes passes the shared
    // once-per-process lines — identical wording and latch to the readline
    // branch's print loop.
    const chatSrc = readFileSync(join(import.meta.dirname, '..', 'commands', 'chat.ts'), 'utf8');
    const tuiCall = chatSrc.slice(chatSrc.indexOf('await runTUI(loop, {'));
    expect(tuiCall.indexOf('startupNotices: configWarningLinesOnce(config),')).toBeGreaterThan(-1);
    expect(tuiCall.indexOf('startupNotices: configWarningLinesOnce(config),')).toBeLessThan(
      tuiCall.indexOf('});'),
    );
  });
});
