import {
  analyzeTrace,
  type RealtimeTokenAnswer,
  TIER_DEGRADED_CODE,
  type VoiceCallEvent,
  type VoiceSocketTransportOptions,
} from '@ethosagent/voice-client';
import { pcm16ToBytes, type VoiceServerFrame } from '@ethosagent/web-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPhoneCallClient, type PhoneCallDeps, phoneVoiceSocketUrl } from '../call-client';
import { createVoiceEngine, type EngineEvent } from '../engine';
import { FakeAppState, FakeBackend, FakeTransport, flush } from './fakes';

const REFUSED: RealtimeTokenAnswer = {
  ok: false,
  reason: 'provider_refused',
  message: 'The realtime provider refused this deployment.',
  providerId: 'openai-realtime',
};

function setup(overrides: Partial<PhoneCallDeps> = {}) {
  const backend = new FakeBackend();
  const appState = new FakeAppState();
  const transport = new FakeTransport();
  const transportOpts: VoiceSocketTransportOptions[] = [];
  const clock = { ms: 0 };
  const tiers: string[] = [];
  const client = createPhoneCallClient({
    serverUrl: 'https://ethos.example.com:8443/app',
    apiKey: 'ek_live_123',
    personalityId: 'researcher',
    now: () => clock.ms,
    loadEngine: async (sampleRate) => createVoiceEngine({ backend, appState, sampleRate }),
    createTransport: (opts) => {
      transportOpts.push(opts);
      return transport;
    },
    onTier: (tier) => tiers.push(tier),
    ...overrides,
  });
  const events: VoiceCallEvent[] = [];
  client.on((event) => events.push(event));
  /** Advance both clocks together, the way the audio hardware does. */
  const advance = (ms: number): void => {
    clock.ms += ms;
    backend.playoutContext.currentTime = clock.ms / 1000;
  };
  /** Mic input in 20 ms chunks, time advancing with each. */
  const speak = (ms: number, amplitude: number): void => {
    for (let t = 0; t < ms; t += 20) {
      advance(20);
      backend.tone(20, amplitude);
    }
  };
  const audioFrame = (
    utteranceId: string,
    seq: number,
    seconds = 1,
  ): [VoiceServerFrame, Uint8Array] => [
    {
      t: 'audio',
      utteranceId,
      segmentId: `${utteranceId}-s1`,
      seq,
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
      sampleRate: 16_000,
    },
    pcm16ToBytes(new Int16Array(16_000 * seconds)),
  ];
  return {
    backend,
    appState,
    transport,
    transportOpts,
    client,
    events,
    tiers,
    clock,
    advance,
    speak,
    audioFrame,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('phoneVoiceSocketUrl', () => {
  it('maps https to wss and http to ws at the origin', () => {
    expect(phoneVoiceSocketUrl('https://ethos.example.com:8443/app')).toBe(
      'wss://ethos.example.com:8443/voice/ws',
    );
    expect(phoneVoiceSocketUrl('http://192.168.1.20:3000')).toBe('ws://192.168.1.20:3000/voice/ws');
  });

  it('refuses a URL that is not http(s)', () => {
    expect(() => phoneVoiceSocketUrl('ftp://x')).toThrow();
  });
});

describe('createPhoneCallClient — tier', () => {
  it('falls back to the pipeline when the realtime token is refused, and says why', async () => {
    const mint = vi.fn(async () => REFUSED);
    const { client, events, tiers, transport } = setup({ mintRealtimeToken: mint });
    await client.connect();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: 'error',
      error: REFUSED.ok ? '' : REFUSED.message,
      code: TIER_DEGRADED_CODE,
    });
    expect(tiers).toEqual(['pipeline']);
    expect(transport.frames('hello')).toEqual([
      { t: 'hello', sampleRate: 16_000, personalityId: 'researcher' },
    ]);
    expect(client.trace()?.events()[0]).toMatchObject({ ev: 'header', tier: 'pipeline' });
  });

  it('a configured pipeline preference falls back silently', async () => {
    const { client, events, tiers } = setup({
      mintRealtimeToken: async () => ({
        ok: false,
        reason: 'pipeline_preferred',
        message: 'pipeline',
        providerId: null,
      }),
    });
    await client.connect();
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(tiers).toEqual(['pipeline']);
  });

  it('a mint that throws still gets a pipeline call', async () => {
    const { client, events, tiers } = setup({
      mintRealtimeToken: async () => {
        throw new Error('offline');
      },
    });
    await client.connect();
    expect(events[0]).toMatchObject({ type: 'error', code: TIER_DEGRADED_CODE });
    expect(tiers).toEqual(['pipeline']);
  });

  it('a minted ticket runs realtime: engine at the provider rate, lane as the control channel', async () => {
    const rates: number[] = [];
    const backend = new FakeBackend();
    const dials: Array<{ url: string; subprotocols?: string[] }> = [];
    const { client, tiers, transport, transportOpts } = setup({
      mintRealtimeToken: async () => ({
        ok: true,
        providerId: 'openai-realtime',
        model: 'gpt-realtime',
        token: 'ek_ephemeral',
        expiresAt: Date.now() + 60_000,
        url: 'wss://api.openai.com/v1/realtime',
        inputSampleRate: 24_000,
        outputSampleRate: 24_000,
      }),
      loadEngine: async (sampleRate) => {
        rates.push(sampleRate);
        return createVoiceEngine({ backend, sampleRate });
      },
      realtimeSocketFactory: (init, handlers) => {
        dials.push(init);
        queueMicrotask(() => handlers.onOpen());
        return { send: () => {}, close: () => {} };
      },
    });
    await client.connect();
    expect(rates).toEqual([24_000]);
    expect(tiers).toEqual(['realtime']);
    expect(dials[0]?.url).toBe('wss://api.openai.com/v1/realtime');
    expect(transportOpts[0]?.headers).toEqual({ Authorization: 'Bearer ek_live_123' });
    expect(transport.frames('realtime_start')).toHaveLength(1);
    expect(backend.preferred).toEqual({ sampleRate: 24_000, bufferLength: 480 });
    expect(client.trace()?.events()[0]).toMatchObject({ ev: 'header', tier: 'realtime' });
  });

  it('forcePipeline never mints', async () => {
    const mint = vi.fn(async () => REFUSED);
    const { client } = setup({ mintRealtimeToken: mint, forcePipeline: true });
    await client.connect();
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('createPhoneCallClient — the lane', () => {
  it('dials wss at the server origin with the bearer key', async () => {
    const { client, transportOpts } = setup();
    await client.connect();
    expect(transportOpts).toEqual([
      {
        url: 'wss://ethos.example.com:8443/voice/ws',
        headers: { Authorization: 'Bearer ek_live_123' },
      },
    ]);
  });

  it('the default transport hands the header to React Native’s WebSocket', async () => {
    const constructed: unknown[][] = [];
    class NativeWebSocket {
      binaryType = '';
      readyState = 1;
      onopen: ((e: unknown) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      constructor(...args: unknown[]) {
        constructed.push(args);
        queueMicrotask(() => this.onopen?.({}));
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', NativeWebSocket);
    const { client } = setup({ createTransport: undefined });
    await client.connect();
    expect(constructed).toEqual([
      [
        'wss://ethos.example.com:8443/voice/ws',
        undefined,
        { headers: { Authorization: 'Bearer ek_live_123' } },
      ],
    ]);
  });

  it('streams 20 ms PCM16 frames up the lane', async () => {
    const { client, transport, speak } = setup();
    await client.connect();
    speak(100, 0.1);
    const audio = transport.sent.filter((s) => s.frame.t === 'audio');
    expect(audio).toHaveLength(5);
    expect(audio[0]?.payload.byteLength).toBe(640);
  });
});

describe('createPhoneCallClient — mute and push-to-talk', () => {
  it('mute stops the uplink; unmute resumes it', async () => {
    const { client, transport, speak } = setup();
    await client.connect();
    client.setMuted(true);
    speak(100, 0.1);
    expect(transport.frames('audio')).toHaveLength(0);
    expect(client.micLevel()).toBe(0);
    client.setMuted(false);
    speak(40, 0.1);
    expect(transport.frames('audio')).toHaveLength(2);
  });

  it('a mute set before the tier is chosen applies to it', async () => {
    const { client, transport, speak } = setup();
    client.setMuted(true);
    await client.connect();
    speak(60, 0.1);
    expect(transport.frames('audio')).toHaveLength(0);
  });

  it('push-to-talk: the mic opens only while held', async () => {
    const { client, transport, speak } = setup();
    await client.connect();
    client.setMuted(true); // PTT mode: closed between presses
    speak(40, 0.1);
    client.setMuted(false); // hold
    speak(60, 0.1);
    client.setMuted(true); // release
    speak(40, 0.1);
    expect(transport.frames('audio')).toHaveLength(3);
  });
});

describe('createPhoneCallClient — local barge-in', () => {
  it('a sustained onset over playout stops it on the phone, and the rest of that reply is dropped', async () => {
    const { client, backend, transport, speak, audioFrame } = setup();
    await client.connect();
    transport.deliver(...audioFrame('u1', 0));
    expect(backend.playoutContext.starts).toHaveLength(1);

    speak(160, 0.3);
    expect(backend.playoutContext.stops).toBeGreaterThan(0);
    const stops = client
      .trace()
      ?.events()
      .filter((e) => e.ev === 'stop');
    expect(stops?.map((e) => (e.ev === 'stop' ? e.reason : ''))).toContain('local_barge_in');

    // The server has not heard the barge-in yet and keeps sending u1.
    transport.deliver(...audioFrame('u1', 1));
    expect(backend.playoutContext.starts).toHaveLength(1);

    // The next reply plays.
    transport.deliver({ t: 'turn_end', utteranceId: 'u1', text: 'Hel', interrupted: true });
    transport.deliver(...audioFrame('u2', 0));
    expect(backend.playoutContext.starts).toHaveLength(2);
  });

  it('talking while nothing plays is not a barge-in', async () => {
    const { client, backend, speak } = setup();
    await client.connect();
    speak(300, 0.3);
    expect(backend.playoutContext.stops).toBe(0);
    expect(
      client
        .trace()
        ?.events()
        .some((e) => e.ev === 'stop'),
    ).toBe(false);
  });
});

describe('createPhoneCallClient — interruptions', () => {
  it('held then resumed reaches the listener and the trace', async () => {
    const { client, backend, transport, audioFrame, speak } = setup();
    const engineEvents: EngineEvent[] = [];
    client.onEngine((event) => engineEvents.push(event));
    await client.connect();
    transport.deliver(...audioFrame('u1', 0));

    backend.interrupt({ type: 'began', shouldResume: false });
    await flush();
    expect(engineEvents).toEqual([{ type: 'held' }]);
    expect(backend.playoutContext.stops).toBeGreaterThan(0);
    speak(60, 0.1);
    expect(transport.frames('audio')).toHaveLength(0);

    backend.interrupt({ type: 'ended', shouldResume: true });
    await flush(20);
    expect(engineEvents).toEqual([{ type: 'held' }, { type: 'resumed' }]);
    speak(40, 0.1);
    expect(transport.frames('audio')).toHaveLength(2);

    const phases = client
      .trace()
      ?.events()
      .flatMap((e) => (e.ev === 'interruption' ? [e.phase] : []));
    expect(phases).toEqual(['began', 'ended']);
  });
});

describe('createPhoneCallClient — trace', () => {
  it('records a full turn that analyzeTrace grades', async () => {
    const { client, transport, speak, advance, audioFrame } = setup();
    const starts: number[] = [];
    client.onPlayoutStart((at) => starts.push(at));
    await client.connect();

    // The user talks for 400 ms, then 800 ms of silence endpoints it locally.
    speak(400, 0.1);
    speak(800, 0);
    const localEnd = client
      .trace()
      ?.events()
      .find((e) => e.ev === 'local_end');
    expect(localEnd).toBeDefined();

    // The server commits, replies, and the first audio lands 300 ms later.
    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'hello', final: true });
    transport.deliver({
      t: 'reply_text',
      utteranceId: 'u1',
      segmentId: 'u1-s1',
      text: 'Hi.',
      kind: 'sentence',
    });
    advance(300);
    transport.deliver(...audioFrame('u1', 0, 1));
    transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 'u1-s1' });
    transport.deliver({ t: 'turn_end', utteranceId: 'u1', text: 'Hi.', interrupted: false });

    const trace = client.trace();
    const kinds = new Set(trace?.events().map((e) => e.ev));
    for (const kind of [
      'header',
      'mic_frame',
      'local_onset',
      'local_end',
      'tx_audio',
      'rx',
      'sched',
      'link',
    ]) {
      expect(kinds.has(kind as never)).toBe(true);
    }

    const report = analyzeTrace(trace?.toJsonl() ?? '');
    expect(report.tier).toBe('pipeline');
    expect(report.malformed).toBe(0);
    expect(report.m2e.samplesMs).toHaveLength(1);
    // First audio is scheduled one playout lead (50 ms) after it arrived.
    const expected = (starts[0] ?? 0) - (localEnd && 't' in localEnd ? localEnd.t : 0);
    expect(report.m2e.samplesMs[0]).toBeCloseTo(expected, 5);
    expect(report.m2e.samplesMs[0]).toBeGreaterThan(300);
  });

  it('the trace survives the hang-up so it can be shared', async () => {
    const { client } = setup();
    await client.connect();
    await client.disconnect();
    expect(client.trace()?.toJsonl()).toContain('"ev":"header"');
  });
});
