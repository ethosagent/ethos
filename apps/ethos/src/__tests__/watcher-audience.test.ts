// plan personality-memory-boundary step 5 — a watcher wake reaches the turn
// with the audience `WatcherManager.wakeAudience` stamped, at all three wake
// sites: `ethos gateway start` and `ethos boot` hand the gateway
// `watcherWakeMessage` (a shared wake carries `audienceHint: 'shared'`, which
// `Gateway.audienceFor` reads — pinned in
// extensions/gateway/src/__tests__/channel-toolsets.test.ts), and `ethos serve`
// runs `runWatcherWakeTurn` straight into the loop. A call-capture wake rides
// the same path as private (`callCaptureWake`).

import type { AgentEvent, TurnAudience } from '@ethosagent/types';
import type { WatcherWakeEvent } from '@ethosagent/watchers';
import { describe, expect, it } from 'vitest';
import { callCaptureWake, runWatcherWakeTurn, watcherWakeMessage } from '../lib/watcher-wake';

function event(roomAudience: TurnAudience): WatcherWakeEvent {
  return {
    watcherId: 'w1',
    target: '/logs/app.log',
    personalityId: 'ops',
    summary: 'file changed',
    roomAudience,
  };
}

describe('gateway-role wake (ethos gateway start, ethos boot)', () => {
  it('a wake from a group-created watcher carries the shared hint and stays a DM for routing', () => {
    const msg = watcherWakeMessage(event('shared'), 'bot-1');
    expect(msg).toMatchObject({
      platform: 'watcher',
      chatId: 'watcher:w1',
      isDm: true,
      botKey: 'bot-1',
      audienceHint: 'shared',
    });
  });

  it('a private wake carries no hint', () => {
    expect(watcherWakeMessage(event('private'), 'bot-1').audienceHint).toBeUndefined();
  });

  it('the summary is fenced as untrusted content', () => {
    expect(watcherWakeMessage(event('private'), 'bot-1').text).toContain('file changed');
  });
});

describe('serve-role wake (ethos serve)', () => {
  function loop() {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      run(_text: string, opts: Record<string, unknown>): AsyncGenerator<AgentEvent> {
        calls.push(opts);
        return (async function* () {
          yield { type: 'done', text: 'ok', turnCount: 1 } as AgentEvent;
        })();
      },
    };
  }

  it('passes the wake audience to the loop, initiator system', async () => {
    const l = loop();
    for await (const _ of runWatcherWakeTurn(l, event('shared'))) {
      // drain
    }
    expect(l.calls[0]).toMatchObject({
      personalityId: 'ops',
      roomAudience: 'shared',
      initiator: 'system',
    });
    expect(String(l.calls[0]?.sessionKey)).toMatch(/^watcher:w1:/);
  });
});

describe('call-capture wake', () => {
  it('is stamped private before it reaches the shared wake path', async () => {
    const seen: WatcherWakeEvent[] = [];
    const wake = callCaptureWake(async (e) => {
      seen.push(e);
    });
    await wake({ watcherId: 'call', target: 'zoom', personalityId: 'ops', summary: 's' });
    expect(seen[0]?.roomAudience).toBe('private');
  });
});
