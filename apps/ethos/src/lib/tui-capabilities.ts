// Capability adapters injected into the TUI through runTUI's options.
// @ethosagent/tui must not import apps/ethos (layering), so chat.ts builds
// these from its own wiring (plugin loader, notification router) and passes
// them across the runTUI boundary. Extracted from chat.ts for unit testing.

import type {
  NotificationAdapter,
  NotificationRouter,
  SlashCommandContext,
} from '@ethosagent/types';
import { type LoopGoals, runGoalSlash, runGoalsSlash } from './goal-slash';

/** Structural subset of PluginLoader that the slash-command adapter needs. */
export interface PluginSlashSource {
  getSlashHandler(
    name: string,
  ): ((args: string, ctx: SlashCommandContext) => Promise<string>) | undefined;
  getAllSlashCommands(): { name: string; description: string; usage: string }[];
}

/** Shape consumed by the TUI's `slashCommands` option (structurally typed). */
export interface TuiSlashCommands {
  list(): { name: string; description: string; usage: string }[];
  dispatch(
    name: string,
    args: string,
    ctx: { sessionKey: string; personalityId: string },
  ): Promise<string | null>;
}

/** No ANSI in the TUI: it renders the returned text itself. */
const PLAIN_PALETTE = { reset: '', dim: '', green: '', red: '', yellow: '' };

/**
 * Slash commands the TUI dispatches through its external seam: plugin
 * commands, and `/goal` + `/goals`, which the TUI has no case for — without
 * this they only ever worked in the non-TTY readline fallback, on the same
 * handler (`goal-slash.ts`) with the same refusal. `dispatch` returns null when
 * nothing here handles `name` (the TUI shows its unknown-command hint);
 * otherwise the text to render. Pinned by __tests__/tui-goal-slash.test.ts.
 */
export function makeTuiSlashCommands(
  initialLoader: PluginSlashSource | undefined,
  goals?: LoopGoals,
): TuiSlashCommands & {
  /** Serve the commands of a new runtime's plugin loader — the chat `/model`
   *  switch calls it, since the replaced loop's dispose unloads its loader
   *  (F06; pinned by apps/ethos/src/__tests__/tui-capabilities.test.ts). */
  rebind(loader: PluginSlashSource | undefined): void;
} {
  let pluginLoader = initialLoader;
  return {
    rebind: (loader) => {
      pluginLoader = loader;
    },
    list: () => pluginLoader?.getAllSlashCommands() ?? [],
    dispatch: async (name, args, ctx) => {
      if (goals && (name === 'goal' || name === 'goals')) {
        const chunks: string[] = [];
        const out = (text: string) => {
          chunks.push(text);
        };
        if (name === 'goals') runGoalsSlash({ goals, out, c: PLAIN_PALETTE });
        else
          await runGoalSlash(args, {
            goals,
            personalityId: ctx.personalityId,
            out,
            c: PLAIN_PALETTE,
          });
        return chunks.join('').trimEnd();
      }
      const handler = pluginLoader?.getSlashHandler(name);
      if (!handler) return null;
      const chunks: string[] = [];
      const result = await handler(args, {
        sessionId: ctx.sessionKey,
        personalityId: ctx.personalityId,
        platform: 'cli',
        send: async (text) => {
          chunks.push(text);
        },
      });
      if (result) chunks.push(result);
      return chunks.join('\n');
    },
  };
}

/**
 * Session-scoped notification subscription for the TUI. Registers an adapter
 * under `sessionKey` and forwards every routed message to `cb`; the returned
 * cleanup deregisters (the TUI re-subscribes when its session key changes).
 */
export function makeTuiNotificationSubscriber(initialRouter: NotificationRouter): ((
  sessionKey: string,
  cb: (text: string) => void,
) => () => void) & {
  /** Move every live subscription to a new runtime's router — the chat
   *  `/model` switch calls it, since the replaced loop's router dies with it
   *  (F06; pinned by apps/ethos/src/__tests__/tui-capabilities.test.ts). */
  rebind(router: NotificationRouter): void;
} {
  let router = initialRouter;
  const live = new Map<string, NotificationAdapter>();
  const subscribe = (sessionKey: string, cb: (text: string) => void) => {
    const adapter: NotificationAdapter = {
      async send(message) {
        cb(message);
      },
      async injectUserMessage(message) {
        // Input injection requires surface integration; surface the text instead.
        cb(message);
      },
    };
    router.register(sessionKey, adapter);
    live.set(sessionKey, adapter);
    return () => {
      if (live.get(sessionKey) === adapter) live.delete(sessionKey);
      router.deregister(sessionKey);
    };
  };
  return Object.assign(subscribe, {
    rebind: (next: NotificationRouter) => {
      for (const [sessionKey, adapter] of live) {
        router.deregister(sessionKey);
        next.register(sessionKey, adapter);
      }
      router = next;
    },
  });
}

/**
 * Wrap one argument in POSIX single quotes, ending and reopening the quote
 * around every embedded `'`. Inside single quotes a shell expands nothing, so
 * spaces, `;`, `&`, backticks and `$(…)` are all literal.
 *
 * The same four lines live in `apps/ethos/src/commands/backup.ts`,
 * `apps/ethos/src/commands/personality-export.ts`,
 * `packages/wiring/src/backup/secrets-manifest.ts`, `extensions/cron/src/index.ts`
 * and `apps/web`'s AddMcpModal. Copied rather than shared: each surface keeps
 * its own module-private copy.
 */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Single source for the skill-evolver proposal notice (readline + TUI).
 *
 * The apply command is quoted because `skillId` is MODEL-controlled, not
 * operator-supplied: `skill_propose` derives it from the LLM's `targetFile`
 * argument. This line exists to be PASTED into a shell, so an id with `;` or
 * `$(…)` in it would produce a line that runs something else entirely. The
 * `.md` suffix goes inside the quotes — the whole argument is one word.
 */
export function formatSkillProposedNotice(skillId: string): string {
  return `[skill-evolver] Proposed skill: ${skillId} — run \`ethos evolve apply ${shellQuote(`${skillId}.md`)}\` to activate`;
}

/** A loop's single-slot skill-proposal setter (`CreateAgentLoopResult.setOnSkillProposed`). */
export type SkillProposedSetter = (fn: (skillId: string, personalityId: string) => void) => void;

/**
 * Skill-proposal notices for the TUI's `onSkillProposed` option, rebindable
 * across a `/model` switch (F06): `rebind` points the live subscription at
 * the new runtime's setter and hands back the release of the old one, which
 * the host runs once that runtime is retired — the replaced loop keeps
 * proposing while it drains, and afterwards its slot must not hold the TUI's
 * callback. Pinned by apps/ethos/src/__tests__/tui-capabilities.test.ts.
 */
export function makeTuiSkillProposalSubscriber(initialSetter: SkillProposedSetter): ((
  cb: (text: string) => void,
) => () => void) & {
  rebind(setter: SkillProposedSetter): () => void;
} {
  let setter = initialSetter;
  let current: ((text: string) => void) | undefined;
  const bind = (target: SkillProposedSetter) =>
    target((skillId) => current?.(formatSkillProposedNotice(skillId)));
  const subscribe = (cb: (text: string) => void) => {
    current = cb;
    bind(setter);
    return () => {
      current = undefined;
      setter(() => {});
    };
  };
  return Object.assign(subscribe, {
    rebind: (next: SkillProposedSetter) => {
      const previous = setter;
      setter = next;
      if (current) bind(next);
      return () => previous(() => {});
    },
  });
}
