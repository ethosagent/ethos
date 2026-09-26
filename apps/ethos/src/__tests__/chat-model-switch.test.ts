// C3 (plan ux-feedback-and-config-clarity §4) — `/model <id>` switches live:
// the rebuilder is called, the REPL's seams are swapped through `apply`, and
// an unknown id is refused through the A3 error map instead of half-switching.

import { describe, expect, it, vi } from 'vitest';
import { performModelSwitch } from '../commands/chat';

describe('performModelSwitch (C3)', () => {
  it('calls the rebuilder with the id and hands the new runtime to apply', async () => {
    const next = { loop: { id: 'new-loop' }, retirePrevious: vi.fn() };
    const rebuild = vi.fn(async (_id: string) => next);
    const apply = vi.fn();

    const outcome = await performModelSwitch('claude-haiku-4', rebuild, apply);

    expect(outcome).toEqual({ ok: true });
    expect(rebuild).toHaveBeenCalledWith('claude-haiku-4');
    expect(apply).toHaveBeenCalledWith(next);
  });

  it('a rebuild that throws is refused with a title and next step; apply never runs', async () => {
    const rebuild = vi.fn(async () => {
      throw new Error("unknown model alias 'nope'");
    });
    const apply = vi.fn();

    const outcome = await performModelSwitch('nope', rebuild, apply);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Unknown codes fall back to the raw message as the title with the
      // shared fallback action (describeChatError, surface-kit).
      expect(outcome.title).toContain("unknown model alias 'nope'");
      expect(outcome.action.length).toBeGreaterThan(0);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('the refusal never half-applies: two failed switches, zero applies', async () => {
    const rebuild = vi.fn(async () => {
      throw new Error('no provider for that model');
    });
    const apply = vi.fn();

    await performModelSwitch('a', rebuild, apply);
    await performModelSwitch('b', rebuild, apply);

    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
  });
});
