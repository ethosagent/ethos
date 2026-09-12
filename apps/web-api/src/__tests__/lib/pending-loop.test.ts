import { type AgentEvent, AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { isEthosError } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createPendingLoop } from '../../lib/pending-loop';

// Onboarding's stand-in loop. Every web-api service is built around it before
// the real loop exists; it used to be a stub that forwarded `run` and nothing
// else, so any other method was a TypeError. It now delegates the whole
// AgentLoop surface to the bound loop, and before a loop is bound fails every
// method with NOT_CONFIGURED (503) — except `run`, which asks the host to boot.

async function drain(loop: AgentLoop): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of loop.run('hi', { sessionKey: 'k' })) events.push(e);
  return events;
}

/** A real AgentLoop instance's surface without constructing one: its methods
 *  are spied per test, and `hooks` is a real registry. */
function fakeRealLoop(): AgentLoop {
  const loop = Object.create(AgentLoop.prototype) as AgentLoop;
  Object.defineProperty(loop, 'hooks', { value: new DefaultHookRegistry() });
  return loop;
}

function notConfigured(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(isEthosError(caught) && caught.code === 'NOT_CONFIGURED').toBe(true);
}

describe('createPendingLoop — before a loop is bound', () => {
  it('fails any AgentLoop method with NOT_CONFIGURED, not a TypeError', () => {
    const standIn = createPendingLoop({ bound: () => undefined });
    notConfigured(() => standIn.getSessionCost('k'));
    notConfigured(() => standIn.compact('k'));
    notConfigured(() => standIn.getAvailableTools());
  });

  it('reads properties as absent', () => {
    const standIn = createPendingLoop({ bound: () => undefined });
    expect(standIn.clarifyBridge).toBeUndefined();
    expect((standIn as { hooks?: unknown }).hooks).toBeUndefined();
    // Not a thenable: awaiting the stand-in must not hang or call anything.
    expect((standIn as { then?: unknown }).then).toBeUndefined();
  });

  it('run yields SETUP_REQUIRED when the host cannot boot a loop yet', async () => {
    const boot = vi.fn(async () => {});
    const standIn = createPendingLoop({ bound: () => undefined, boot });
    const events = await drain(standIn);
    expect(boot).toHaveBeenCalledTimes(1);
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'SETUP_REQUIRED' })]);
  });
});

describe('createPendingLoop — once a loop is bound', () => {
  it('delegates methods and properties to the bound loop', async () => {
    const real = fakeRealLoop();
    const compact = vi.spyOn(real, 'compact').mockResolvedValue({ ok: true } as never);
    vi.spyOn(real, 'getSessionCost').mockReturnValue(0.42);
    const standIn = createPendingLoop({ bound: () => real });

    await standIn.compact('web:s1');
    expect(compact).toHaveBeenCalledWith('web:s1');
    expect(standIn.getSessionCost('web:s1')).toBe(0.42);
    expect(standIn.hooks).toBe(real.hooks);
  });

  it('run boots, then forwards the turn to the loop the host bound', async () => {
    const real = fakeRealLoop();
    const turn = vi.spyOn(real, 'run').mockImplementation(async function* () {
      yield { type: 'done', text: 'from the real loop', turnCount: 1 } as AgentEvent;
    });
    let bound: AgentLoop | undefined;
    const standIn = createPendingLoop({
      bound: () => bound,
      boot: async () => {
        bound = real;
      },
    });

    const events = await drain(standIn);
    expect(turn).toHaveBeenCalledWith('hi', { sessionKey: 'k' });
    expect(events).toEqual([expect.objectContaining({ type: 'done', text: 'from the real loop' })]);
  });
});
