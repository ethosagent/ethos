import { describe, expect, it } from 'vitest';
import { PlayoutQueue } from '../playout-queue';
import type { AudioFormat } from '../types';
import { deferred, tick } from './fakes';

function oneChunk(byte: number) {
  return async function* (): AsyncIterable<{ audio: Uint8Array; format: AudioFormat }> {
    yield { audio: new Uint8Array([byte]), format: 'pcm' };
  };
}

describe('PlayoutQueue', () => {
  it('plays enqueued items in order and tracks played text', async () => {
    const audio: number[] = [];
    const q = new PlayoutQueue({
      onAudio: (a) => audio.push(a[0] ?? -1),
    });
    q.enqueue({ text: 'one', synthesize: oneChunk(1) });
    q.enqueue({ text: 'two', synthesize: oneChunk(2) });
    q.enqueue({ text: 'three', synthesize: oneChunk(3) });
    await q.idle();

    expect(audio).toEqual([1, 2, 3]);
    expect(q.playedText()).toEqual(['one', 'two', 'three']);
  });

  it('cancel drops pending items and does not mark the in-flight one as played', async () => {
    const audio: number[] = [];
    let secondSynthesized = false;
    const gate = deferred();

    const q = new PlayoutQueue({
      onAudio: (a) => audio.push(a[0] ?? -1),
    });

    q.enqueue({
      text: 'first',
      synthesize: async function* (signal) {
        yield { audio: new Uint8Array([1]), format: 'pcm' };
        await gate.promise;
        if (signal.aborted) return;
        yield { audio: new Uint8Array([2]), format: 'pcm' };
      },
    });
    q.enqueue({
      text: 'second',
      synthesize: async function* () {
        secondSynthesized = true;
        yield { audio: new Uint8Array([9]), format: 'pcm' };
      },
    });

    await tick(); // let the first chunk of "first" emit
    q.cancel();
    gate.resolve();
    await q.idle();

    expect(audio).toEqual([1]); // only the first chunk played
    expect(q.playedText()).toEqual([]); // interrupted item is not "played"
    expect(secondSynthesized).toBe(false); // pending item dropped
  });
});
