import type { NotificationRouter, NotifyOptions, SlashCommandContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  formatSkillProposedNotice,
  makeTuiNotificationSubscriber,
  makeTuiSkillProposalSubscriber,
  makeTuiSlashCommands,
  type PluginSlashSource,
} from '../lib/tui-capabilities';

describe('makeTuiSlashCommands', () => {
  it('lists nothing and dispatches null without a plugin loader', async () => {
    const cmds = makeTuiSlashCommands(undefined);
    expect(cmds.list()).toEqual([]);
    expect(await cmds.dispatch('anything', '', { sessionKey: 's', personalityId: 'p' })).toBeNull();
  });

  it('returns null for a name no plugin handles', async () => {
    const loader: PluginSlashSource = {
      getSlashHandler: () => undefined,
      getAllSlashCommands: () => [],
    };
    const cmds = makeTuiSlashCommands(loader);
    expect(await cmds.dispatch('nope', 'args', { sessionKey: 's', personalityId: 'p' })).toBeNull();
  });

  it('lists plugin commands from the loader', () => {
    const loader: PluginSlashSource = {
      getSlashHandler: () => undefined,
      getAllSlashCommands: () => [
        { name: 'standup', description: 'Daily standup', usage: '/standup' },
      ],
    };
    expect(makeTuiSlashCommands(loader).list()).toEqual([
      { name: 'standup', description: 'Daily standup', usage: '/standup' },
    ]);
  });

  it('accumulates send() chunks and the handler return value', async () => {
    const handler = async (args: string, ctx: SlashCommandContext) => {
      await ctx.send('chunk one');
      await ctx.send('chunk two');
      return `done with ${args}`;
    };
    const loader: PluginSlashSource = {
      getSlashHandler: (name) => (name === 'standup' ? handler : undefined),
      getAllSlashCommands: () => [],
    };
    const cmds = makeTuiSlashCommands(loader);
    const result = await cmds.dispatch('standup', 'today', {
      sessionKey: 'cli:proj',
      personalityId: 'engineer',
    });
    expect(result).toBe('chunk one\nchunk two\ndone with today');
  });

  it('passes session and personality through to the handler context', async () => {
    let seen: SlashCommandContext | undefined;
    const loader: PluginSlashSource = {
      getSlashHandler: () => async (_args, ctx) => {
        seen = ctx;
        return '';
      },
      getAllSlashCommands: () => [],
    };
    await makeTuiSlashCommands(loader).dispatch('x', '', {
      sessionKey: 'cli:proj:123',
      personalityId: 'coach',
    });
    expect(seen?.sessionId).toBe('cli:proj:123');
    expect(seen?.personalityId).toBe('coach');
    expect(seen?.platform).toBe('cli');
  });
});

describe('makeTuiNotificationSubscriber', () => {
  function makeRouter() {
    const adapters = new Map<
      string,
      { send: (m: string) => Promise<void>; injectUserMessage: (m: string) => Promise<void> }
    >();
    const router: NotificationRouter = {
      async route(_pluginId: string, opts: NotifyOptions) {
        await adapters.get(opts.sessionKey)?.send(opts.message);
      },
      register: vi.fn((key, adapter) => {
        adapters.set(key, adapter);
      }),
      deregister: vi.fn((key) => {
        adapters.delete(key);
      }),
    };
    return { router, adapters };
  }

  it('registers an adapter that forwards send() to the callback', async () => {
    const { router } = makeRouter();
    const subscribe = makeTuiNotificationSubscriber(router);
    const received: string[] = [];
    subscribe('cli:proj', (text) => received.push(text));

    await router.route('plugin-x', { sessionKey: 'cli:proj', message: 'build done' });
    expect(received).toEqual(['build done']);
  });

  it('forwards injectUserMessage to the callback too', async () => {
    const { router, adapters } = makeRouter();
    const received: string[] = [];
    makeTuiNotificationSubscriber(router)('cli:proj', (text) => received.push(text));

    await adapters.get('cli:proj')?.injectUserMessage('wake up');
    expect(received).toEqual(['wake up']);
  });

  it('cleanup deregisters the session key', async () => {
    const { router } = makeRouter();
    const received: string[] = [];
    const unsubscribe = makeTuiNotificationSubscriber(router)('cli:proj', (t) => received.push(t));
    unsubscribe();

    await router.route('plugin-x', { sessionKey: 'cli:proj', message: 'late' });
    expect(received).toEqual([]);
    expect(router.deregister).toHaveBeenCalledWith('cli:proj');
  });
});

// F06 follow-up — the TUI `/model` switch replaces the loop; the replaced
// loop's dispose unloads ITS plugin loader and drops ITS notification router.
// Adapters bound to the first loop's then served nothing: plugin slash commands
// vanished after `/model`, and plugin notifications stopped arriving.
describe('TUI capability adapters follow a /model switch (F06)', () => {
  it('slash commands rebind to the new runtime’s plugin loader', async () => {
    const first = {
      getAllSlashCommands: () => [{ name: 'hello', description: 'd', usage: '/hello' }],
      getSlashHandler: () => async () => 'from first',
    };
    const second = {
      getAllSlashCommands: () => [{ name: 'hello', description: 'd', usage: '/hello' }],
      getSlashHandler: () => async () => 'from second',
    };
    const cmds = makeTuiSlashCommands(first);
    cmds.rebind(second);
    expect(cmds.list().map((c) => c.name)).toEqual(['hello']);
    expect(await cmds.dispatch('hello', '', { sessionKey: 's', personalityId: 'p' })).toBe(
      'from second',
    );
  });

  it('live notification subscriptions move to the new runtime’s router', async () => {
    const make = () => {
      const adapters = new Map<string, { send: (m: string) => Promise<void> }>();
      const router: NotificationRouter = {
        async route(_p: string, opts: NotifyOptions) {
          await adapters.get(opts.sessionKey)?.send(opts.message);
        },
        register: vi.fn((key, adapter) => {
          adapters.set(key, adapter);
        }),
        deregister: vi.fn((key) => {
          adapters.delete(key);
        }),
      };
      return router;
    };
    const oldRouter = make();
    const newRouter = make();
    const received: string[] = [];
    const subscribe = makeTuiNotificationSubscriber(oldRouter);
    const unsubscribe = subscribe('cli:proj', (t) => received.push(t));

    subscribe.rebind(newRouter);
    await newRouter.route('plugin-x', { sessionKey: 'cli:proj', message: 'from the new loop' });
    expect(received).toEqual(['from the new loop']);
    expect(oldRouter.deregister).toHaveBeenCalledWith('cli:proj');

    unsubscribe();
    expect(newRouter.deregister).toHaveBeenCalledWith('cli:proj');
  });
});

// F06 follow-up — skill-proposal notices, like slash commands and
// notifications, were bound to the FIRST loop's improvement fork: after
// `/model` the new loop's proposals never reached the TUI.
describe('skill-proposal notices follow a /model switch (F06)', () => {
  /** A loop's single-slot `setOnSkillProposed` and a way to fire it. */
  function makeSlot() {
    let fn: ((skillId: string, personalityId: string) => void) | undefined;
    return {
      set: (next: (skillId: string, personalityId: string) => void) => {
        fn = next;
      },
      propose: (skillId: string) => fn?.(skillId, 'p'),
    };
  }

  it('rebinds to the new runtime, and releases the old slot when it is retired', () => {
    const oldLoop = makeSlot();
    const newLoop = makeSlot();
    const received: string[] = [];
    const subscribe = makeTuiSkillProposalSubscriber(oldLoop.set);
    subscribe((text) => received.push(text));

    const releaseOld = subscribe.rebind(newLoop.set);
    newLoop.propose('from-new');
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('from-new');

    // Until the old runtime is retired it may still propose (it drains first).
    oldLoop.propose('from-old-while-draining');
    expect(received).toHaveLength(2);

    releaseOld();
    oldLoop.propose('after-retire');
    expect(received).toHaveLength(2);
  });

  it('unsubscribe releases the current slot', () => {
    const slot = makeSlot();
    const received: string[] = [];
    const subscribe = makeTuiSkillProposalSubscriber(slot.set);
    const unsubscribe = subscribe((text) => received.push(text));
    unsubscribe();
    slot.propose('late');
    expect(received).toEqual([]);
  });
});

describe('formatSkillProposedNotice', () => {
  // Inverts POSIX single-quoting. Throws on any character outside the quotes,
  // so an unquoted or half-quoted argument provably fails to decode. Copied
  // from the sibling paste-line tests rather than imported across packages.
  const decodeSingleQuoted = (arg: string): string => {
    let text = '';
    let i = 0;
    while (i < arg.length) {
      if (arg[i] !== "'") throw new Error(`unquoted text at ${i}: ${arg}`);
      const close = arg.indexOf("'", i + 1);
      if (close < 0) throw new Error(`unterminated quote: ${arg}`);
      text += arg.slice(i + 1, close);
      i = close + 1;
      if (i < arg.length) {
        if (arg.slice(i, i + 2) !== "\\'") throw new Error(`junk between quotes: ${arg}`);
        text += "'";
        i += 2;
      }
    }
    return text;
  };

  /** The single argument between `ethos evolve apply ` and the closing backtick. */
  const applyArg = (notice: string): string => {
    const start = notice.indexOf('`ethos evolve apply ');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = notice.slice(start + '`ethos evolve apply '.length);
    const end = rest.indexOf('`');
    expect(end).toBeGreaterThanOrEqual(0);
    return rest.slice(0, end);
  };

  it('names the skill and the apply command', () => {
    expect(formatSkillProposedNotice('summarize-prs')).toBe(
      "[skill-evolver] Proposed skill: summarize-prs — run `ethos evolve apply 'summarize-prs.md'` to activate",
    );
    expect(decodeSingleQuoted(applyArg(formatSkillProposedNotice('summarize-prs')))).toBe(
      'summarize-prs.md',
    );
  });

  it('quotes a skill id containing a space', () => {
    const notice = formatSkillProposedNotice('rewrite-a b-1');
    expect(notice).toContain("`ethos evolve apply 'rewrite-a b-1.md'`");
    expect(decodeSingleQuoted(applyArg(notice))).toBe('rewrite-a b-1.md');
  });

  it('quotes a skill id containing `;` and `$(…)`', () => {
    const notice = formatSkillProposedNotice('rewrite-a;rm -rf ~ $(id)-1');
    expect(decodeSingleQuoted(applyArg(notice))).toBe('rewrite-a;rm -rf ~ $(id)-1.md');
  });

  it('quotes a skill id containing an embedded single quote', () => {
    const notice = formatSkillProposedNotice("rewrite-a'; id #-1");
    expect(decodeSingleQuoted(applyArg(notice))).toBe("rewrite-a'; id #-1.md");
  });

  it('keeps the `.md` suffix inside the quotes', () => {
    // The suffix must be part of the same shell word, not a bare `.md` that a
    // closing quote would strand outside it.
    expect(formatSkillProposedNotice('x')).toContain("apply 'x.md'`");
  });
});
