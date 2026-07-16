import type { DeliveryResult, OutboundMessage } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { MessageDedupCache } from '../dedup';
import { closeUnbalancedMarkup, DraftStreamer, parseRetryAfterSeconds } from '../streaming';

// ---------------------------------------------------------------------------
// A controllable clock so throttle behavior is deterministic.
// ---------------------------------------------------------------------------
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface EditCall {
  messageId: string;
  text: string;
}

function fakeAdapter(opts: { editResult?: () => DeliveryResult } = {}) {
  const sends: OutboundMessage[] = [];
  const edits: EditCall[] = [];
  let nextId = 1;
  return {
    sends,
    edits,
    send: vi.fn(async (_chatId: string, message: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(message);
      return { ok: true, messageId: String(nextId++) };
    }),
    editMessage: vi.fn(
      async (_chatId: string, messageId: string, text: string): Promise<DeliveryResult> => {
        edits.push({ messageId, text });
        return opts.editResult ? opts.editResult() : { ok: true, messageId };
      },
    ),
  };
}

describe('closeUnbalancedMarkup', () => {
  it('closes an open code fence', () => {
    const out = closeUnbalancedMarkup('here is code:\n```js\nconst x = 1');
    expect(out.match(/```/g)?.length).toBe(2);
    expect(out.endsWith('```')).toBe(true);
  });

  it('leaves a balanced fence untouched', () => {
    const src = 'a\n```\ncode\n```\nb';
    expect(closeUnbalancedMarkup(src)).toBe(src);
  });

  it('strips a dangling bold opener', () => {
    expect(closeUnbalancedMarkup('this is **bol')).toBe('this is bol');
  });

  it('strips a dangling inline-code opener', () => {
    expect(closeUnbalancedMarkup('call `foo')).toBe('call foo');
  });

  it('does not miscount backticks inside a closed fence', () => {
    const src = 'x\n```\na `b` c\n```\ny';
    expect(closeUnbalancedMarkup(src)).toBe(src);
  });
});

describe('parseRetryAfterSeconds', () => {
  it('parses grammy flood-wait errors', () => {
    expect(
      parseRetryAfterSeconds(
        "Call to 'editMessageText' failed! (429: Too Many Requests: retry after 7)",
      ),
    ).toBe(7);
  });
  it('falls back to 1 on a bare 429', () => {
    expect(parseRetryAfterSeconds('HTTP 429 rate limited')).toBe(1);
  });
  it('returns null for non-flood errors', () => {
    expect(parseRetryAfterSeconds('message not found')).toBeNull();
    expect(parseRetryAfterSeconds(undefined)).toBeNull();
  });
});

describe('DraftStreamer', () => {
  function makeStreamer(
    adapter: ReturnType<typeof fakeAdapter>,
    clock: ReturnType<typeof fakeClock>,
    overrides: Partial<{ onFloodDisable: () => void; sleep: (ms: number) => Promise<void> }> = {},
  ) {
    const dedup = new MessageDedupCache({ ttlMs: 60_000 });
    const streamer = new DraftStreamer({
      adapter,
      chatId: 'c1',
      threadId: undefined,
      sessionKey: 'sess-1',
      dedup,
      minEditIntervalMs: 2500,
      now: clock.now,
      sleep: overrides.sleep ?? (async () => {}),
      ...(overrides.onFloodDisable ? { onFloodDisable: overrides.onFloodDisable } : {}),
    });
    return { streamer, dedup };
  }

  it('sends the first chunk immediately (no placeholder) and registers it in dedup', async () => {
    const adapter = fakeAdapter();
    const clock = fakeClock();
    const { streamer, dedup } = makeStreamer(adapter, clock);

    await streamer.pushText('Hel');
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.sends[0]?.text).toBe('Hel');
    expect(adapter.edits).toHaveLength(0);
    // First-chunk content is registered.
    expect(dedup.shouldSend('sess-1', 'Hel')).toBe(false);
  });

  it('throttles intermediate edits, then lands a byte-identical final via edit', async () => {
    const adapter = fakeAdapter();
    const clock = fakeClock();
    const { streamer, dedup } = makeStreamer(adapter, clock);

    await streamer.pushText('Hel'); // first message
    await streamer.pushText('Hello wor'); // within 2500ms → throttled (no edit)
    expect(adapter.editMessage).not.toHaveBeenCalled();

    // finalize lands the true final content byte-identical.
    const delivered = await streamer.finalize('Hello world');
    expect(delivered).toBe(true);
    expect(adapter.edits.at(-1)?.text).toBe('Hello world');
    // Final content registered in dedup.
    expect(dedup.shouldSend('sess-1', 'Hello world')).toBe(false);
  });

  it('emits a throttled intermediate edit once the interval elapses', async () => {
    const adapter = fakeAdapter();
    const clock = fakeClock();
    const { streamer } = makeStreamer(adapter, clock);

    await streamer.pushText('one'); // first send
    clock.advance(3000);
    await streamer.pushText('one two'); // interval elapsed → edit
    expect(adapter.editMessage).toHaveBeenCalledTimes(1);
    expect(adapter.edits[0]?.text).toBe('one two');
  });

  it('balances unbalanced markup on intermediate edits but not the final', async () => {
    const adapter = fakeAdapter();
    const clock = fakeClock();
    const { streamer } = makeStreamer(adapter, clock);

    await streamer.pushText('```js\nconst x'); // first message — balanced
    expect(adapter.sends[0]?.text.match(/```/g)?.length).toBe(2);

    // Final has the real, complete (balanced) fence — passed through verbatim.
    await streamer.finalize('```js\nconst x = 1;\n```');
    expect(adapter.edits.at(-1)?.text).toBe('```js\nconst x = 1;\n```');
  });

  it('folds an audience:user progress line as the last italic line', async () => {
    const adapter = fakeAdapter();
    const clock = fakeClock();
    const { streamer } = makeStreamer(adapter, clock);

    await streamer.pushText('working on it'); // first message
    clock.advance(3000);
    await streamer.pushProgress('reading file (2 of 5)');
    const body = adapter.edits.at(-1)?.text ?? '';
    expect(body.endsWith('_reading file (2 of 5)_')).toBe(true);
  });

  it('degrades to non-streaming after two consecutive flood-waits', async () => {
    const adapter = fakeAdapter({
      editResult: () => ({ ok: false, error: '429: Too Many Requests: retry after 3' }),
    });
    const clock = fakeClock();
    const onFloodDisable = vi.fn();
    const { streamer } = makeStreamer(adapter, clock, { onFloodDisable });

    await streamer.pushText('a'); // first send ok
    // Two throttle-elapsed edits both flood-wait → degrade.
    clock.advance(3000);
    await streamer.pushText('a b'); // flood-wait #1 (sleeps, does not degrade)
    clock.advance(3000);
    await streamer.pushText('a b c'); // flood-wait #2 → degrade
    expect(onFloodDisable).toHaveBeenCalledTimes(1);
    expect(streamer.isDegraded).toBe(true);
  });

  it('finalize returns false when nothing was ever delivered', async () => {
    const adapter = fakeAdapter();
    const clock = fakeClock();
    const { streamer } = makeStreamer(adapter, clock);
    // No pushText at all.
    const delivered = await streamer.finalize('never streamed');
    expect(delivered).toBe(false);
    expect(adapter.send).not.toHaveBeenCalled();
  });
});
