// Plan keyless-first-run §3.6: the readline setup path finds a local Ollama
// without a typed key or URL, and `setup --keyless` (D23) takes only a `local`
// or `ethos-login` candidate and never imports, installs or pulls.
//
// The Ollama is a fake `fetch` bound to 127.0.0.1:11434 (real probe code, no
// socket) so the test cannot collide with a developer's own Ollama.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../wiring', async () => (await import('./setup-test-harness')).wiringMock());

import { probeKeyless } from '@ethosagent/wiring/keyless-probe';
import { runReadlineFallback, runSetupKeyless } from '../setup';
import {
  afterEachHarness,
  beforeEachHarness,
  fakeOllamaFetch,
  harness,
  scripted,
} from './setup-test-harness';

const probeWith = (models: string[], servedWindow?: number) => () =>
  probeKeyless({
    secrets: harness.secrets,
    platform: 'linux',
    totalMemBytes: 16 * 1024 ** 3,
    isRoot: false,
    fetchImpl: fakeOllamaFetch(models, servedWindow),
    home: harness.root,
  });

beforeEach(beforeEachHarness);
afterEach(afterEachHarness);

describe('readline setup with a local Ollama', () => {
  it('writes provider ollama, the /v1 base URL, the placeholder key and the served model', async () => {
    // Choose 1 (the local server, recommended), keep the built-in personality
    // default, then accept the default agent name; no connectors, no task.
    const io = scripted(['1', '', '', '', '']);
    const outcome = await runReadlineFallback({
      storage: harness.storage,
      existing: null,
      deps: { ask: io.ask, probe: probeWith(['llama3.2:latest']), interactive: true },
    });

    expect(outcome?.keylessPath).toBe('local');
    expect(outcome?.config.provider).toBe('ollama');
    expect(outcome?.config.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(outcome?.config.model).toBe('llama3.2:latest');
    // The first question is the keyless one, before any provider/key prompt.
    expect(io.asked[0]).toMatch(/Choose 1-/);
    expect(io.asked.some((q) => /API key|Provider \(/.test(q))).toBe(false);

    const yaml = await readFile(join(harness.dataDir, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('provider: ollama');
    expect(yaml).toContain('baseUrl: http://127.0.0.1:11434/v1');
    expect(yaml).toContain('model: llama3.2:latest');
    // The placeholder key lives in the vault, never inline.
    expect(await harness.secrets.get('providers/ollama/apiKey')).toBe('local');
  });

  it('a re-run with an existing config skips the keyless prompts (D13)', async () => {
    const probe = vi.fn(probeWith(['llama3.2:latest']));
    const io = scripted(['y', 'ollama', 'http://127.0.0.1:11434/v1', '', 'llama3.2', '', '']);
    await runReadlineFallback({
      storage: harness.storage,
      existing: { provider: 'ollama', model: 'x', apiKey: '', personality: 'researcher' },
      deps: { ask: io.ask, probe, interactive: false },
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('ethos setup --keyless', () => {
  it('takes the local candidate, writes config, creates the born copy and stamps the path', async () => {
    const outcome = await runSetupKeyless({ probe: probeWith(['qwen3:8b']) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.keylessPath).toBe('local');
    expect(outcome.config.provider).toBe('ollama');
    expect(outcome.config.model).toBe('qwen3:8b');
    expect(outcome.config.personality).toBe('my-researcher');
    expect(harness.funnel.firstLaunches).toBe(1);
    expect(harness.funnel.setups).toEqual([expect.objectContaining({ keylessPath: 'local' })]);
    // Nothing was imported into the vault.
    expect(await harness.secrets.get('providers/codex/tokens')).toBeNull();
  });

  it('exits non-ok with the probe summary and writes nothing when no candidate qualifies', async () => {
    const outcome = await runSetupKeyless({ probe: probeWith([]) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.summary).toMatch(/No keyless model is ready/);
    expect(outcome.summary).toMatch(/Install Ollama/);
    expect(await harness.storage.exists(join(harness.dataDir, 'config.yaml'))).toBe(false);
  });

  it('refuses a machine whose only local model is below the floor, naming served vs required', async () => {
    const outcome = await runSetupKeyless({ probe: probeWith(['llama3.2:latest'], 8192) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.summary).toMatch(/serves 8192 tokens; Ethos needs 16000/);
    expect(outcome.summary).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(await harness.storage.exists(join(harness.dataDir, 'config.yaml'))).toBe(false);
  });
});

describe('readline setup with a below-floor Ollama', () => {
  it('prints the remediation, writes nothing, and falls through when the person pastes a key', async () => {
    // 1 = the below-floor local (refused, list re-shown); 2 = paste a key.
    const io = scripted(['1', '2']);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
    try {
      const outcome = await runReadlineFallback({
        storage: harness.storage,
        existing: null,
        deps: { ask: io.ask, probe: probeWith(['llama3.2:latest'], 8192), interactive: false },
      }).catch(() => null);
      expect(outcome?.keylessPath).not.toBe('local');
    } finally {
      log.mockRestore();
    }
    expect(lines.join('\n')).toMatch(/serves 8192 tokens; Ethos needs 16000/);
    // The list was shown again after the refused pick.
    expect(io.asked[0]).toMatch(/Choose 1-/);
    expect(io.asked[1]).toMatch(/Choose 1-/);
  });
});
