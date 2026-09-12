import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { type AgentEvent, type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { ActivityEvent, SseEvent } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../../features/chat/repository';
import { ChatService } from '../../features/chat/service';

// F06 — web-api owns the chat turns its ChatService started, and the loop they
// run on is disposed right after web-api's own dispose. `close()` is the step
// in between: no new turn, no queued turn, every in-flight turn aborted and
// waited for.

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

interface TurnLog {
  started: string[];
  finished: string[];
}

/** A loop whose turns park until aborted (or, with `ignoreAbort`, forever). */
function parkingLoop(log: TurnLog, opts: { ignoreAbort?: boolean } = {}): AgentLoop {
  return {
    hooks: new DefaultHookRegistry(),
    async *run(input: string, runOpts: { abortSignal: AbortSignal }): AsyncGenerator<AgentEvent> {
      log.started.push(input);
      if (opts.ignoreAbort) await new Promise(() => {});
      await waitForAbort(runOpts.abortSignal);
      log.finished.push(input);
      yield { type: 'error', error: 'Aborted', code: 'aborted' };
    },
  } as unknown as AgentLoop;
}

async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ChatService.close (F06)', () => {
  let store: SQLiteSessionStore;
  let buffer: SessionStreamBuffer<SseEvent>;
  let activityBuffer: SessionStreamBuffer<ActivityEvent>;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    buffer = new SessionStreamBuffer<SseEvent>();
    activityBuffer = new SessionStreamBuffer<ActivityEvent>();
  });

  afterEach(() => {
    buffer.destroy();
    activityBuffer.destroy();
    store.close();
  });

  function makeService(loop: AgentLoop): ChatService {
    return new ChatService({
      loop,
      sessions: new ChatRepository(store),
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
  }

  it('aborts the in-flight turn, drops the queued one, and resolves once the turn unwound', async () => {
    const log: TurnLog = { started: [], finished: [] };
    const service = makeService(parkingLoop(log));
    const { sessionId } = await service.send({ clientId: 'tab', text: 'first' });
    await until(() => service.hasActiveBridges());
    // Queued behind the running turn.
    await service.send({ sessionId, clientId: 'tab', text: 'second' });

    await service.close();

    expect(log.finished).toEqual(['first']);
    expect(service.hasActiveBridges()).toBe(false);
    // The queued input never became a turn on the loop being torn down...
    await new Promise((r) => setTimeout(r, 20));
    expect(log.started).toEqual(['first']);
    // ...and the tab is told it was not sent, rather than it vanishing.
    const events: SseEvent[] = [];
    service.subscribe(sessionId, 0, (e) => {
      events.push(e.event);
    })();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', error: expect.stringMatching(/not sent/) }),
    );
  });

  it('refuses new turns once closed', async () => {
    const service = makeService(parkingLoop({ started: [], finished: [] }));
    await service.close();
    await expect(service.send({ clientId: 'tab', text: 'late' })).rejects.toThrow(/shutting down/);
  });

  // A send that was already past its entry check when `close()` ran: it awaits
  // session creation, attachment writes and a personality refresh before the
  // turn starts, and the turn must not start on a loop about to be disposed.
  it('a send in flight when close() runs starts no turn and leaves no half-made session', async () => {
    const log: TurnLog = { started: [], finished: [] };
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const service = new ChatService({
      loop: parkingLoop(log),
      sessions: new ChatRepository(store),
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      attachmentCache: {
        write: async () => {
          await writeGate;
          return 'ethos-attachment://x';
        },
      } as unknown as import('@ethosagent/types').AttachmentCache,
    });

    const sending = service.send({
      clientId: 'tab',
      text: 'with a file',
      attachments: [{ type: 'file', data: 'aGk=', mimeType: 'text/plain', name: 'a.txt' }],
    } as Parameters<ChatService['send']>[0]);
    await new Promise((r) => setTimeout(r, 20));
    await service.close();
    releaseWrite?.();

    await expect(sending).rejects.toThrow(/shutting down/);
    expect(log.started).toEqual([]);
    // The session this send created for itself is gone again.
    expect(await store.listSessions({ limit: 10 })).toHaveLength(0);
  });

  it('stops waiting after the grace period for a turn that ignores its abort', async () => {
    const log: TurnLog = { started: [], finished: [] };
    const service = makeService(parkingLoop(log, { ignoreAbort: true }));
    await service.send({ clientId: 'tab', text: 'stuck' });
    await until(() => service.hasActiveBridges());

    const started = Date.now();
    await service.close(30);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
