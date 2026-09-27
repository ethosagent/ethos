import { classifyVoiceStartError, MIC_DENIED_CODE } from '@ethosagent/voice-client';
import { describe, expect, it } from 'vitest';
import { createVoiceEngine, type EngineEvent, sniffAudioMime } from '../engine';
import { FakeAppState, FakeBackend, flush } from './fakes';

function setup(sampleRate = 16_000) {
  const backend = new FakeBackend();
  const appState = new FakeAppState();
  const engine = createVoiceEngine({ backend, sampleRate, appState });
  const frames: Int16Array[] = [];
  const levels: number[] = [];
  const events: EngineEvent[] = [];
  engine.capture.on((event) => {
    if (event.type === 'frame') frames.push(event.data);
  });
  engine.onFrame((_frame, rms) => levels.push(rms));
  engine.on((event) => events.push(event));
  return { backend, appState, engine, frames, levels, events };
}

describe('createVoiceEngine — capture', () => {
  it('opens the session and asks the recorder for 20 ms at the lane rate', async () => {
    const { backend, engine } = setup();
    await engine.capture.start();
    expect(backend.configured).toBe(1);
    expect(backend.sessionActive).toBe(true);
    expect(backend.preferred).toEqual({ sampleRate: 16_000, bufferLength: 320 });
    expect(engine.capture.sampleRate).toBe(16_000);
  });

  it('refuses with a NotAllowedError the shared classifier reads as mic-denied', async () => {
    const { backend, engine } = setup();
    backend.micAllowed = false;
    const err = await engine.capture.start().catch((e: unknown) => e);
    expect(classifyVoiceStartError(err).code).toBe(MIC_DENIED_CODE);
    expect(backend.recording).toBe(false);
  });

  it('resamples whatever the hardware delivers into 320-sample PCM16 frames', async () => {
    const { backend, engine, frames } = setup();
    await engine.capture.start();
    // 48 kHz hardware, 30 ms: 1440 samples → 480 at 16 kHz → one frame + a held remainder.
    backend.tone(30, 0.5, 48_000);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(320);
    // The converter holds back one output until its span is complete, so the
    // second frame needs a sample more than an exact 40 ms.
    backend.tone(10, 0.5, 48_000);
    expect(frames).toHaveLength(1);
    backend.tone(1, 0.5, 48_000);
    expect(frames).toHaveLength(2);
  });

  it('reports an RMS per frame and a smoothed mic level', async () => {
    const { backend, engine, levels } = setup();
    await engine.capture.start();
    backend.tone(100, 0.25);
    expect(levels).toHaveLength(5);
    expect(levels[0]).toBeCloseTo(0.25, 2);
    expect(engine.capture.micLevel()).toBeGreaterThan(0);
  });

  it('mute drops frames and zeroes the level', async () => {
    const { backend, engine, frames } = setup();
    await engine.capture.start();
    engine.capture.setMicEnabled(false);
    backend.tone(40, 0.5);
    expect(frames).toHaveLength(0);
    expect(engine.capture.micLevel()).toBe(0);
    engine.capture.setMicEnabled(true);
    backend.tone(40, 0.5);
    expect(frames).toHaveLength(2);
  });

  it('stop releases the recorder, the session and the context', async () => {
    const { backend, engine } = setup();
    await engine.capture.start();
    await engine.capture.stop();
    expect(backend.recording).toBe(false);
    expect(backend.sessionActive).toBe(false);
    expect(backend.closed).toBe(true);
  });

  it('plays the earcon through the backend', () => {
    const { backend, engine } = setup();
    engine.capture.playEarcon();
    expect(backend.earcons).toBe(1);
  });
});

describe('createVoiceEngine — interruptions', () => {
  it('began: playout stops, the uplink mutes, held is emitted', async () => {
    const { backend, engine, frames, events } = setup();
    await engine.capture.start();
    engine.playout.playPcm16(new Int16Array(16_000), 16_000);
    expect(engine.playout.speaking).toBe(true);

    backend.interrupt({ type: 'began', shouldResume: false });
    await flush();
    expect(engine.playout.speaking).toBe(false);
    expect(engine.held).toBe(true);
    expect(events).toEqual([{ type: 'held' }]);
    backend.tone(40, 0.5);
    expect(frames).toHaveLength(0);
  });

  it('ended(shouldResume): reactivates, restarts the recorder, unmutes, resumed', async () => {
    const { backend, engine, frames, events } = setup();
    await engine.capture.start();
    backend.interrupt({ type: 'began', shouldResume: false });
    await flush();
    backend.sessionActive = false;
    backend.interrupt({ type: 'ended', shouldResume: true });
    await flush(20);
    expect(backend.sessionActive).toBe(true);
    expect(backend.recorderStarts).toBe(2);
    expect(engine.held).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['held', 'resumed']);
    backend.tone(20, 0.5);
    expect(frames).toHaveLength(1);
  });

  it('a user mute survives the interruption', async () => {
    const { backend, engine, frames } = setup();
    await engine.capture.start();
    engine.capture.setMicEnabled(false);
    backend.interrupt({ type: 'began', shouldResume: false });
    backend.interrupt({ type: 'ended', shouldResume: true });
    await flush(20);
    backend.tone(40, 0.5);
    expect(frames).toHaveLength(0);
  });

  it('returning to the app re-arms a call iOS never sent ended for', async () => {
    const { backend, appState, engine, events } = setup();
    await engine.capture.start();
    backend.interrupt({ type: 'began', shouldResume: false });
    await flush();
    appState.becomeActive();
    await flush(20);
    expect(engine.held).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['held', 'resumed']);
  });

  it('a failed reactivation stays held and the next app-active retries', async () => {
    const { backend, appState, engine, events } = setup();
    await engine.capture.start();
    backend.interrupt({ type: 'began', shouldResume: false });
    backend.failActivation = true;
    backend.interrupt({ type: 'ended', shouldResume: true });
    await flush(20);
    expect(engine.held).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['held', 'error']);

    backend.failActivation = false;
    appState.becomeActive();
    await flush(20);
    expect(engine.held).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['held', 'error', 'resumed']);
  });

  it('interruptions after the call ended are ignored', async () => {
    const { backend, engine, events } = setup();
    await engine.capture.start();
    await engine.capture.stop();
    backend.interrupt({ type: 'began', shouldResume: false });
    await flush();
    expect(events).toEqual([]);
  });
});

const OGG_HEAD = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 1, 2, 3]);

describe('createVoiceEngine — playout', () => {
  it('creates PCM buffers at the output rate, resampled, for the same duration', () => {
    const { backend, engine } = setup();
    const end = engine.playout.playPcm16(new Int16Array(2_400).fill(16_384), 24_000);
    const [buffer] = backend.playoutContext.buffers;
    expect(buffer?.sampleRate).toBe(48_000);
    expect(buffer?.frames).toBe(4_800);
    expect(buffer?.samples).toHaveLength(4_800);
    expect(buffer?.samples?.[4_799]).toBeCloseTo(0.5, 5);
    expect(end).toBeCloseTo(0.05 + 0.1, 9);
  });

  it('passes PCM already at the output rate through untouched', () => {
    const { backend, engine } = setup();
    engine.playout.playPcm16(new Int16Array(480), 48_000);
    expect(backend.playoutContext.buffers[0]).toMatchObject({ sampleRate: 48_000, frames: 480 });
  });

  it('an undecodable clip surfaces an engine error, once per type, and still rejects', async () => {
    const { backend, engine, events } = setup();
    backend.playoutContext.decodeError = new Error('Failed to decode any frames');
    await expect(engine.playout.playEncoded(OGG_HEAD)).rejects.toThrow('Failed to decode');
    await expect(engine.playout.playEncoded(OGG_HEAD)).rejects.toThrow('Failed to decode');
    expect(events).toEqual([
      {
        type: 'error',
        code: 'undecodable_audio',
        mime: 'audio/ogg',
        message: "Can't play audio/ogg on this phone.",
        detail: 'Failed to decode any frames',
      },
    ]);
  });

  it('a decodable clip reports nothing', async () => {
    const { engine, events } = setup();
    await engine.playout.playEncoded(OGG_HEAD);
    expect(events).toEqual([]);
  });
});

describe('sniffAudioMime', () => {
  const bytes = (text: string, pad = 12): Uint8Array =>
    Uint8Array.from({ length: Math.max(pad, text.length) }, (_, i) => text.charCodeAt(i) || 0);
  it.each([
    ['OggS', 'audio/ogg'],
    ['ID3', 'audio/mpeg'],
    ['fLaC', 'audio/flac'],
    ['RIFF\0\0\0\0WAVE', 'audio/wav'],
    ['\0\0\0\0ftypM4A ', 'audio/mp4'],
    ['hello world!', 'unrecognised audio'],
  ])('%s → %s', (head, mime) => {
    expect(sniffAudioMime(bytes(head))).toBe(mime);
  });

  it('reads MPEG and ADTS frame sync', () => {
    expect(sniffAudioMime(Uint8Array.from([0xff, 0xfb, 0x90]))).toBe('audio/mpeg');
    expect(sniffAudioMime(Uint8Array.from([0xff, 0xf1, 0x50]))).toBe('audio/aac');
  });
});
