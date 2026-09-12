import { describe, expect, it, vi } from 'vitest';
import { createLoopRebuilder } from '../loop-rebuilder';

// F06 follow-up — `ethos chat`'s `/model` switch hands the TUI the new loop
// AND the release of the runtime it replaces; before this the replaced
// runtime's dispose was simply dropped.
describe('createLoopRebuilder (F06)', () => {
  it('pairs each rebuilt loop with the retirement of the runtime it replaces', async () => {
    const order: string[] = [];
    const initial = {
      drain: vi.fn(async () => void order.push('drain')),
      dispose: vi.fn(async () => void order.push('dispose')),
    };
    const disposeInitial = initial.dispose;
    const built: Array<{
      loop: string;
      dispose: ReturnType<typeof vi.fn>;
      drain: () => Promise<void>;
    }> = [];
    const rebuild = createLoopRebuilder(initial, async (modelId: string) => {
      const runtime = {
        loop: `loop:${modelId}`,
        drain: async () => {},
        dispose: vi.fn(async () => {}),
      };
      built.push(runtime);
      return runtime;
    });

    const first = await rebuild('model-b');
    expect(first.loop).toBe('loop:model-b');
    await first.retirePrevious();
    expect(disposeInitial).toHaveBeenCalledTimes(1);
    // F06 follow-up — drained first: its background jobs and goal runs finish
    // on the loop they started on instead of being aborted by the dispose.
    expect(order).toEqual(['drain', 'dispose']);

    const second = await rebuild('model-c');
    await second.retirePrevious();
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(built[1]?.dispose).not.toHaveBeenCalled();
  });

  it('keeps the current runtime when a rebuild fails', async () => {
    const disposeInitial = vi.fn(async () => {});
    const rebuild = createLoopRebuilder(
      { drain: async () => {}, dispose: disposeInitial },
      async () => {
        throw new Error('unknown model');
      },
    );
    await expect(rebuild('nope')).rejects.toThrow('unknown model');
    expect(disposeInitial).not.toHaveBeenCalled();
  });
});
