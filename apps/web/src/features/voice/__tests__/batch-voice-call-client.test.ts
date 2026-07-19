import { describe, expect, it, vi } from 'vitest';
import {
  type BatchVoiceCallDeps,
  createBatchVoiceCallClient,
  type SynthesizedClip,
  splitSentences,
  type UtteranceCapture,
  type VoiceIoDriver,
} from '../batch-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';

// Fake browser-audio driver: feeds preloaded utterances, records play() calls,
// and lets a test trigger barge-in on demand — so the whole client loop runs in
// the node vitest env with no getUserMedia / AudioContext / MediaRecorder.
class FakeVoiceIoDriver implements VoiceIoDriver {
  readonly utterances: UtteranceCapture[] = [];
  readonly playCalls: string[] = [];
  captureCalls = 0;
  started = false;
  stopped = false;
  blockPlayback = false;
  private bargeEnabled = false;
  private readonly bargeListeners = new Set<() => void>();

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  micStream(): MediaStream | null {
    return null;
  }

  setMicEnabled(): void {}

  captureUtterance(signal: AbortSignal): Promise<UtteranceCapture | null> {
    this.captureCalls++;
    const next = this.utterances.shift();
    if (next) return Promise.resolve(next);
    // No more preloaded utterances — resolve null once disconnect aborts, so
    // the loop terminates cleanly under the test's control.
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  play(audioBase64: string, _mimeType: string, signal: AbortSignal): Promise<void> {
    this.playCalls.push(audioBase64);
    if (!this.blockPlayback) return Promise.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    });
  }

  onBargeIn(listener: () => void): () => void {
    this.bargeListeners.add(listener);
    return () => this.bargeListeners.delete(listener);
  }

  setBargeInEnabled(enabled: boolean): void {
    this.bargeEnabled = enabled;
  }

  triggerBargeIn(): void {
    if (!this.bargeEnabled) return;
    for (const listener of [...this.bargeListeners]) listener();
  }

  stopPlayback(): void {}

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

function collect(client: ReturnType<typeof createBatchVoiceCallClient>): VoiceCallEvent[] {
  const events: VoiceCallEvent[] = [];
  client.on((event) => events.push(event));
  return events;
}

function texts(events: VoiceCallEvent[], type: 'reply_sentence'): string[] {
  return events
    .filter((e): e is Extract<VoiceCallEvent, { type: 'reply_sentence' }> => e.type === type)
    .map((e) => e.text);
}

describe('splitSentences', () => {
  it('splits on terminators followed by whitespace, keeping the remainder', () => {
    expect(splitSentences('Hello there. How are ')).toEqual({
      sentences: ['Hello there.'],
      rest: 'How are ',
    });
  });

  it('does not split a decimal or a terminator with no trailing whitespace', () => {
    expect(splitSentences('pi is 3.14 today')).toEqual({ sentences: [], rest: 'pi is 3.14 today' });
    expect(splitSentences('Done.')).toEqual({ sentences: [], rest: 'Done.' });
  });

  it('handles multiple sentences and clustered terminators', () => {
    expect(splitSentences('Yes! No? Maybe. tail')).toEqual({
      sentences: ['Yes!', 'No?', 'Maybe.'],
      rest: 'tail',
    });
  });
});

describe('createBatchVoiceCallClient — full turn cycle', () => {
  it('listens → commits an utterance → speaks sentences in order → completes → listens again', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    const synthOrder: string[] = [];
    const deps: BatchVoiceCallDeps = {
      transcribe: () => Promise.resolve('  hello there  '),
      synthesize: (text): Promise<SynthesizedClip> => {
        synthOrder.push(text);
        return Promise.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' });
      },
      runAgentTurn: async function* () {
        yield 'Hi friend. ';
        yield 'How are you?';
      },
      createDriver: () => driver,
    };

    const client = createBatchVoiceCallClient(deps);
    const events = collect(client);
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));

    // Transcript trimmed and committed.
    expect(events.find((e) => e.type === 'utterance_committed')).toEqual({
      type: 'utterance_committed',
      text: 'hello there',
    });
    // Sentences split, synthesized, and played in order.
    expect(texts(events, 'reply_sentence')).toEqual(['Hi friend.', 'How are you?']);
    expect(synthOrder).toEqual(['Hi friend.', 'How are you?']);
    expect(driver.playCalls).toEqual(['tts:Hi friend.', 'tts:How are you?']);
    // reply_complete carries the whole reply.
    expect(events.find((e) => e.type === 'reply_complete')).toEqual({
      type: 'reply_complete',
      text: 'Hi friend. How are you?',
    });

    // Hands-free: the loop returns to listening (captures again).
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    await client.disconnect();
    expect(driver.stopped).toBe(true);
  });

  it('drops an empty transcript without running an agent turn', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    const runAgentTurn = vi.fn(async function* () {
      yield 'unreachable';
    });
    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('   '),
      runAgentTurn,
      createDriver: () => driver,
    });
    const events = collect(client);
    await client.connect();

    // Loop moves on to the next capture without committing anything.
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(false);
    expect(runAgentTurn).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('surfaces the reply as text (no synthesis) when no TTS is configured', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('hi'),
      runAgentTurn: async function* () {
        yield 'Text only. ';
      },
      createDriver: () => driver,
    });
    const events = collect(client);
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    expect(texts(events, 'reply_sentence')).toEqual(['Text only.']);
    expect(driver.playCalls).toEqual([]); // nothing synthesized → nothing played
    await client.disconnect();
  });
});

describe('createBatchVoiceCallClient — barge-in', () => {
  it('aborts the turn, emits interrupted, and returns to listening', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.blockPlayback = true; // hold playout so barge-in lands mid-turn
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    let turnAborted = false;
    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('tell me a long story'),
      synthesize: (text) => Promise.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' }),
      runAgentTurn: async function* (_text, signal) {
        signal.addEventListener('abort', () => {
          turnAborted = true;
        });
        yield 'Once upon a time. ';
        yield 'The end.';
      },
      createDriver: () => driver,
    });
    const events = collect(client);
    await client.connect();

    // Wait until the first sentence is playing (blocked), then speak over it.
    await vi.waitFor(() => expect(driver.playCalls.length).toBeGreaterThanOrEqual(1));
    driver.triggerBargeIn();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'interrupted')).toBe(true));
    expect(turnAborted).toBe(true);

    // Recovers hands-free: the loop listens for the next utterance.
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    await client.disconnect();
  });
});
