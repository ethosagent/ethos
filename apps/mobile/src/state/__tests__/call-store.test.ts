import { analyzeTrace, TIER_DEGRADED_CODE } from '@ethosagent/voice-client';
import { pcm16ToBytes } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';

// `./connection` (the production client wiring) pulls in `../auth/keychain`;
// the real expo-secure-store drags in react-native's flow-typed entry point,
// which vitest cannot parse (handlers.test.ts mocks it for the same reason).
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { FakeAppState, FakeBackend, FakeTransport, flush } from '../../voice/__tests__/fakes';
import { createPhoneCallClient, type PhoneCallDeps } from '../../voice/call-client';
import { createVoiceEngine } from '../../voice/engine';
import { createCallStore } from '../call-store';

function setup(overrides: Partial<PhoneCallDeps> = {}) {
  const backend = new FakeBackend();
  const transport = new FakeTransport();
  const clock = { ms: 1_000 };
  const store = createCallStore({
    now: () => clock.ms,
    createClient: (options, hooks) =>
      createPhoneCallClient({
        serverUrl: 'http://10.0.0.2:3000',
        apiKey: 'ek_1',
        now: () => clock.ms,
        loadEngine: async (sampleRate) =>
          createVoiceEngine({ backend, sampleRate, appState: new FakeAppState() }),
        createTransport: () => transport,
        onTier: hooks.onTier,
        ...(options.personalityId ? { personalityId: options.personalityId } : {}),
        ...overrides,
      }),
  });
  const advance = (ms: number): void => {
    clock.ms += ms;
    backend.playoutContext.currentTime = clock.ms / 1000;
  };
  const speak = (ms: number, amplitude: number): void => {
    for (let t = 0; t < ms; t += 20) {
      advance(20);
      backend.tone(20, amplitude);
    }
  };
  return { backend, transport, store, advance, speak };
}

async function started(overrides: Partial<PhoneCallDeps> = {}) {
  const ctx = setup(overrides);
  ctx.store.getState().start({ personalityId: 'researcher' });
  await flush(20);
  return ctx;
}

describe('call-store', () => {
  it('start → listening on the pipeline tier', async () => {
    const { store, transport } = await started();
    expect(store.getState().call.status).toBe('listening');
    expect(store.getState().call.tier).toBe('pipeline');
    expect(transport.frames('hello')).toHaveLength(1);
  });

  it('a refused realtime token shows the notice and the call goes on', async () => {
    const { store } = await started({
      mintRealtimeToken: async () => ({
        ok: false,
        reason: 'local_only',
        message: 'Local-only mode refused the realtime provider.',
        providerId: 'openai-realtime',
      }),
    });
    expect(store.getState().call.notice).toBe('Local-only mode refused the realtime provider.');
    expect(store.getState().call.status).toBe('listening');
    expect(TIER_DEGRADED_CODE).toBe('realtime_unavailable');
  });

  it('end hangs up and releases the engine', async () => {
    const { store, backend, transport } = await started();
    store.getState().end();
    await flush(20);
    expect(store.getState().call.status).toBe('ended');
    expect(transport.closed).toBe(true);
    expect(backend.recording).toBe(false);
  });

  it('a refused mic ends the call as mic-denied guidance', async () => {
    const ctx = setup();
    ctx.backend.micAllowed = false;
    ctx.store.getState().start();
    await flush(20);
    expect(ctx.store.getState().call.micDenied).toBe(true);
    expect(ctx.store.getState().call.status).toBe('ended');
  });

  it('a client that cannot be built ends the call instead of hanging in connecting', () => {
    const store = createCallStore({
      createClient: () => {
        throw new Error('Not connected');
      },
    });
    store.getState().start();
    expect(store.getState().call.status).toBe('ended');
    expect(store.getState().call.error).toBe('Not connected');
  });

  it('toggleMute closes and reopens the uplink', async () => {
    const { store, transport, speak } = await started();
    store.getState().toggleMute();
    expect(store.getState().muted).toBe(true);
    speak(60, 0.1);
    expect(transport.frames('audio')).toHaveLength(0);
    store.getState().toggleMute();
    speak(40, 0.1);
    expect(transport.frames('audio')).toHaveLength(2);
  });

  it('push-to-talk: open while held, closed after release', async () => {
    const { store, transport, speak } = await started();
    store.getState().holdToTalk();
    expect(store.getState()).toMatchObject({ pushToTalk: true, muted: false });
    speak(40, 0.1);
    store.getState().releaseToTalk();
    expect(store.getState().muted).toBe(true);
    speak(60, 0.1);
    expect(transport.frames('audio')).toHaveLength(2);
  });

  it('held follows the OS interruption', async () => {
    const { store, backend } = await started();
    backend.interrupt({ type: 'began', shouldResume: false });
    await flush();
    expect(store.getState().held).toBe(true);
    backend.interrupt({ type: 'ended', shouldResume: true });
    await flush(20);
    expect(store.getState().held).toBe(false);
  });

  it('latency marks: committed → sentence → first audio', async () => {
    const { store, transport, advance } = await started();
    transport.deliver({
      t: 'transcript',
      utteranceId: 'u1',
      text: 'what time is it',
      final: true,
      provider: 'deepgram',
    });
    advance(400);
    transport.deliver({
      t: 'reply_text',
      utteranceId: 'u1',
      segmentId: 's1',
      text: 'It is noon.',
      kind: 'sentence',
    });
    advance(150);
    transport.deliver(
      {
        t: 'audio',
        utteranceId: 'u1',
        segmentId: 's1',
        seq: 0,
        codec: 'pcm_s16le',
        mimeType: 'audio/pcm',
        sampleRate: 16_000,
        provider: 'elevenlabs',
      },
      pcm16ToBytes(new Int16Array(8_000)),
    );
    // First audio is scheduled one 50 ms playout lead after it landed.
    expect(store.getState().latency).toEqual({ llmMs: 400, ttsMs: 200, totalMs: 600 });
    expect(store.getState().call.sttProvider).toBe('deepgram');
    expect(store.getState().providerLabel()).toBe('deepgram');
  });

  it('the realtime provider names itself in the label', async () => {
    const { store } = await started({
      mintRealtimeToken: async () => ({
        ok: true,
        providerId: 'openai-realtime',
        model: 'gpt-realtime',
        token: 't',
        expiresAt: Date.now() + 60_000,
        url: 'wss://provider',
        inputSampleRate: 16_000,
        outputSampleRate: 24_000,
      }),
      realtimeSocketFactory: (_init, handlers) => {
        queueMicrotask(() => handlers.onOpen());
        return { send: () => {}, close: () => {} };
      },
    });
    expect(store.getState().call.tier).toBe('realtime');
    expect(store.getState().providerLabel()).toBe('openai-realtime · gpt-realtime');
  });

  it('the trace JSONL is still there after the hang-up, and grades', async () => {
    const { store, speak } = await started();
    speak(200, 0.1);
    store.getState().end();
    await flush(20);
    const jsonl = store.getState().traceJsonl();
    expect(jsonl).not.toBeNull();
    const report = analyzeTrace(jsonl ?? '');
    expect(report.tier).toBe('pipeline');
    expect(report.malformed).toBe(0);
  });

  it('micLevel reads the live capture and is 0 with no call', async () => {
    const { store, speak } = await started();
    speak(100, 0.2);
    expect(store.getState().micLevel()).toBeGreaterThan(0);
    store.getState().end();
    expect(store.getState().micLevel()).toBe(0);
  });
});
