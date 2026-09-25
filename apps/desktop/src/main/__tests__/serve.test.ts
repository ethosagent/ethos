import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';

// Mock electron-store before importing serve (store.ts depends on it)
vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string) {
      return undefined;
    }
  },
}));

// Mock keychain (depends on Electron safeStorage)
vi.mock('../keychain', () => ({
  getKeychainValue: vi.fn().mockResolvedValue(null),
}));

import { getPort, readSharedExecutionFlags, readSharedVoiceAndCallCaptureConfig } from '../serve';

// Builds a literal `${secrets:<path>}` ref via concatenation (not a template
// literal) so biome's noTemplateCurlyInString rule doesn't mistake the
// config-file placeholder syntax for an unresolved template string.
function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('serve', () => {
  it('getPort returns null when no server is running', () => {
    expect(getPort()).toBeNull();
  });
});

// `readSharedVoiceAndCallCaptureConfig` — the desktop app's read of the
// CLI's `~/.ethos/config.yaml` `auxiliary.asr`/`auxiliary.tts`/`callCapture`
// sections, so call-capture's STT provider AND its personality binding are
// wired the same way `ethos serve` wires them (see the doc comment on the
// function in `../serve` for the full story, including why the
// `callCapture` fallback exists — without it, a fresh desktop install
// crashes on startup whenever a personality unconditionally ships the
// `call_capture` toolset capability).
describe('readSharedVoiceAndCallCaptureConfig', () => {
  it('maps auxiliary.asr into auxiliaryAsr, with secret refs resolved', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('auxiliary/asr/apiKey', 'sk-real-stt-key');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-unrelated',
        'personality: researcher',
        'auxiliary.asr.provider: openai-stt',
        `auxiliary.asr.apiKey: ${secretRef('auxiliary/asr/apiKey')}`,
        'auxiliary.asr.model: whisper-1',
      ].join('\n'),
    );

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result.auxiliaryAsr).toEqual({
      provider: 'openai-stt',
      apiKey: 'sk-real-stt-key',
      model: 'whisper-1',
    });
    expect(result.auxiliaryTts).toBeUndefined();
    expect(result.callCapture).toBeUndefined();
  });

  it('maps callCapture.personalityId into callCapture', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-unrelated',
        'personality: researcher',
        'callCapture.personalityId: voice',
      ].join('\n'),
    );

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result.callCapture).toEqual({ personalityId: 'voice' });
    expect(result.auxiliaryAsr).toBeUndefined();
    expect(result.auxiliaryTts).toBeUndefined();
  });

  it('returns {} when config.yaml does not exist', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result).toEqual({});
  });

  it('returns {} when config.yaml has no auxiliary.asr/auxiliary.tts/callCapture section', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-unrelated',
        'personality: researcher',
      ].join('\n'),
    );

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result).toEqual({});
  });
});

// `execution.allowLocalFallback` / `execution.containerized` — the operator's
// execution flags from the shared `~/.ethos/config.yaml`, forwarded into the
// desktop's wiring config so each key means on the desktop what it means for
// `ethos serve` / `gateway` / `boot` (`createExecutionRouting`,
// packages/wiring/src/compose-tools.ts).
describe('readSharedExecutionFlags', () => {
  async function withConfig(lines: string[]) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: k', 'personality: p', ...lines].join('\n'),
    );
    return readSharedExecutionFlags(storage, new InMemorySecretsResolver());
  }

  it('forwards both flags when set', async () => {
    expect(
      await withConfig(['execution.allowLocalFallback: true', 'execution.containerized: true']),
    ).toEqual({ execution: { allowLocalFallback: true, containerized: true } });
  });

  it('forwards execution.containerized on its own', async () => {
    expect(await withConfig(['execution.containerized: true'])).toEqual({
      execution: { containerized: true },
    });
  });

  it('forwards nothing when neither flag is set, or config.yaml is absent', async () => {
    expect(await withConfig([])).toEqual({});
    expect(
      await readSharedExecutionFlags(new InMemoryStorage(), new InMemorySecretsResolver()),
    ).toEqual({});
  });
});

// Settings › Execution probe — the desktop's half of the registry thread
// (plan `remote-execution-routing.md`, T7 follow-up). The desktop is the third
// in-process web-API host alongside `ethos serve` and `ethos boot`; without
// this the probe answers `backend_unresolved` in the desktop app only.
//
// The property is INSTANCE IDENTITY: `DefaultExecutionBackendRegistry.resolve()`
// memoises, so the loop's registry holds the SAME backend the tools execute on.
// A probe against a second registry built here would report on an object
// nothing runs commands through — worse than no probe, because it reads as
// reassurance. Asserted against source (`startServer` cannot be called without
// a live Electron main process), the same way apps/ethos's
// execution-probe-thread.test.ts covers `serve.ts`/`boot.ts`.
describe('the desktop backend threads the loop execution-backend registry', () => {
  it('takes the registry off the createAgentLoop result and forwards it', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'serve.ts'), 'utf8');
    // Destructured from the loop result — not constructed here.
    expect(src).toContain('executionBackends,');
    expect(src).not.toContain('new DefaultExecutionBackendRegistry');
    // One binding, used twice: once out of `createAgentLoop`, once into
    // `createWebApi`. Two occurrences is the thread; one would mean a dangling
    // destructure or an invented object.
    expect(src.match(/^\s*executionBackends,$/gm)).toHaveLength(2);
  });
});

// Goals (plan architecture-suggestions-2026-09-10 F05). The desktop never
// forwarded the loop-bearing goal runner, so GoalsService fell back to a
// runner with no `runAttempt`: a desktop-created goal was stored `running` and
// nothing ever executed it. The property is again INSTANCE IDENTITY — the
// store + executor pair `createAgentLoop` built (one goals.db handle, the
// runner bound to the loop) is the pair the web API drives; nothing here
// builds a second one. Asserted against source for the same reason as the
// blocks above: `startServer` needs a live Electron main process.
describe('the desktop backend forwards the loop goal backend', () => {
  it('takes `goals` off the createAgentLoop result and hands it to createWebApi', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'serve.ts'), 'utf8');
    // One binding, used twice: destructured out of `createAgentLoop`, then
    // passed into `createWebApi`.
    expect(src.match(/^\s*goals,$/gm)).toHaveLength(2);
    expect(src).not.toMatch(/new (GoalRunner|SQLiteGoalStore)\b/);
  });
});

// The browser-takeover screencast lane (plan B3, T8). The desktop is the third
// in-process web-API host: `createAgentLoop` builds the browser tools HERE, so
// the session `browser_request_takeover` locked is one this process can reach —
// unlike `ethos gateway`, which opens its Chromium elsewhere and is honestly
// refused. Two halves, both host-side: the registry the socket looks sessions
// up in, and the attach without which the path never upgrades at all. Asserted
// against source for the same reason as the block above — `startServer` needs a
// live Electron main process.
describe('the desktop backend wires the browser-takeover lane', () => {
  it('passes the session registry and attaches the socket to the bound server', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'serve.ts'), 'utf8');
    expect(src).toContain('browserTakeoverSessions: createBrowserTakeoverRegistry(),');
    expect(src).toContain('takeoverSocket.attach(s);');
    // Taken off the `createWebApi` result, like the other two lanes.
    expect(src).toMatch(/^\s*takeoverSocket,$/m);
    // Handed to the runtime's socket list, which `shutdownDesktopRuntime`
    // closes before `server.close()` (that waits on the open lane otherwise) —
    // the order is pinned in runtime-shutdown.test.ts.
    expect(src).toContain('rt.sockets = [voiceSocket, satelliteSocket, takeoverSocket];');
  });
});

// Memory (plan architecture-suggestions-2026-09-10 F04). The desktop handed the
// web API a markdown-only `createMemoryProvider` at dataDir, so under
// `memory: vault` the desktop memory editor, Timeline and restore worked on
// files the agent never reads. The bundle `createAgentLoop` built from this
// same config is the one the web API drives; nothing here builds another.
// Asserted against source for the same reason as the blocks above.
describe('the desktop backend forwards the loop memory bundle', () => {
  it('takes `memoryBundle` off the createAgentLoop result and hands it to createWebApi', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'serve.ts'), 'utf8');
    // One binding, used twice: destructured out of `createAgentLoop`, then
    // passed into `createWebApi`.
    expect(src.match(/^\s*memoryBundle,$/gm)).toHaveLength(2);
    expect(src).not.toContain('createMemoryProvider(');
    expect(src).not.toContain('memoryBackend:');
  });
});
