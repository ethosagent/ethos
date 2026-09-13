// Agent-callable watcher lifecycle tools (toolset: 'watchers').
//
// A personality whose toolset includes 'watchers' can own declarative
// zero-token watchers — the deterministic differ runs on the cron
// scheduler's tick with no LLM involvement; the agent is only woken (or a
// channel notified) on a real change. Ownership is toolset membership plus
// the watcher record's explicit targets — nothing is added to
// PersonalityConfig (plan gap-event-triggers §3e).

import type { Tool, ToolResult } from '@ethosagent/types';
import {
  isForeignDeliverForGatedOwner,
  MIN_INTERVAL_SECONDS,
  type WatcherDeliveryGate,
  type WatcherKind,
  type WatcherManager,
  type WatcherOnChange,
  type WatcherOwner,
  type WatcherRecord,
} from '@ethosagent/watchers';

function fail(error: string): ToolResult {
  return { ok: false, error, code: 'input_invalid' };
}

function fromError(err: unknown): ToolResult {
  return fail(err instanceof Error ? err.message : String(err));
}

function formatWatcher(w: WatcherRecord): string {
  const actions: string[] = [];
  if (w.onChange.deliver) {
    actions.push(`deliver → ${w.onChange.deliver.platform}:${w.onChange.deliver.chatId}`);
  }
  if (w.onChange.wake) actions.push(`wake → ${w.onChange.wake.personalityId}`);
  const status = w.enabled ? 'active' : 'paused';
  const line = `${w.id} [${w.kind}] ${w.target} — every ${w.intervalSeconds}s, ${actions.join(', ')} (${status})`;
  return w.deliveryWithheld ? `${line}\n  ${w.deliveryWithheld.reason}` : line;
}

interface DeliverArg {
  platform?: string;
  chat_id?: string;
}

interface WakeArg {
  personality_id?: string;
  prompt_prefix?: string;
}

// ---------------------------------------------------------------------------
// The approval outbox seam (O-T12, plan/phases/trust-before-reach.md)
//
// A watcher's `deliver` sends the change summary VERBATIM to whatever channel
// the agent names, with no LLM turn and nobody reading it first. For a
// personality whose `outbound_policy.approve_before_send` is on, that is the
// exact publication the policy exists to hold back — so it is stopped at both
// ends and pointed at `wake`, where the woken agent's `send_message` meets the
// gate in `@ethosagent/tools-messaging`:
//
// - At CREATION, `watcher_create` refuses the foreign target (`refuseForeignDeliver`
//   below).
// - At DELIVERY, `WatcherManager.dispatchChange` (`@ethosagent/watchers`) asks
//   the same question again on every change, so a watcher stored before the
//   policy was switched on stops delivering on its next tick. The withheld
//   change is not dropped silently: the reason, naming `wake`, is persisted as
//   `WatcherRecord.deliveryWithheld` (shown by `watcher_list`) and logged; any
//   `wake` on the same watcher still fires. Pinned by "a watcher stored before
//   gating stops delivering and records why" in
//   `src/__tests__/outbox-deliver-refusal.test.ts`.
//
// Both ends share one predicate, `isForeignDeliverForGatedOwner`, and read the
// policy through the gate on every call — both gates look the personality up
// each time, so a hot-reloaded policy applies without a restart.
// `createWatcherTools` records the creating turn as `WatcherRecord.owner`. It
// does NOT hand its gate to the manager: the delivery-time half reads the gate
// the app root gave the manager at construction
// (`WatcherManagerConfig.deliveryGate`), so a tick that fires before any loop is
// composed is still checked, and a second loop composed in a multi-bot gateway
// cannot replace it. Pinned by "a tick before any loop is composed still
// withholds a gated foreign deliver" and "composing more loops does not replace
// the manager's gate" in `src/__tests__/outbox-deliver-refusal.test.ts`.
//
// The gate is `WatcherDeliveryGate` from `@ethosagent/watchers` — the questions,
// not the queue; a watcher never proposes anything. Declared structurally, for
// the same reason the messaging gate is. Both halves come from
// `packages/wiring/src/compose-tools.ts`: `createOutboxGate` (this option, per
// loop) builds on `createOutboundPolicyGate` (the manager's, per app root), so
// the policy reading has one owner.
//
// The limitation: a record with no `owner` — written before owners were
// recorded, or created outside an agent turn — names no personality whose
// policy could apply, so it still delivers. An operator turning approval on for
// a personality that owns such watchers has to recreate them.
// ---------------------------------------------------------------------------

export type WatcherOutboxGate = WatcherDeliveryGate;

export interface WatcherToolsOptions {
  /**
   * Approval outbox. Absent — every surface that wires none — and
   * `watcher_create` behaves exactly as it did before O-T12 (pinned by "an
   * ungated personality unchanged" in
   * `src/__tests__/outbox-deliver-refusal.test.ts`).
   */
  outbox?: WatcherOutboxGate;
}

/**
 * Refuse a `deliver` target that would publish to a third party, for a gated
 * personality. `undefined` means the watcher may be created. The exemptions
 * live in `isForeignDeliverForGatedOwner`, shared with the delivery-time hold.
 */
function refuseForeignDeliver(
  gate: WatcherOutboxGate | undefined,
  owner: WatcherOwner | undefined,
  platform: string,
  chatId: string,
): ToolResult | undefined {
  if (!gate || !owner) return undefined;
  if (!isForeignDeliverForGatedOwner(gate, owner, { platform, chatId })) return undefined;
  return fail(
    'This personality publishes only through the approval outbox ' +
      `(outbound_policy.approve_before_send), and a watcher's deliver would send every change ` +
      `to ${platform}:${chatId} verbatim with nobody reviewing it. Use wake instead: wake a ` +
      `personality with the change, and the send_message it chooses to make is queued for ` +
      `approval like any other publication.`,
  );
}

export function createWatcherTools(
  manager: WatcherManager,
  opts: WatcherToolsOptions = {},
): Tool[] {
  const idSchema = {
    type: 'string',
    description: 'Watcher id (lowercase letters, digits, hyphens).',
  };

  const createTool: Tool = {
    name: 'watcher_create',
    description:
      'Create a declarative zero-token watcher. A deterministic differ (file hash, HTTP ETag/content, RSS GUIDs, process alive/dead) runs on a schedule with no LLM involvement; on a change it delivers a short summary to a channel and/or wakes a personality. At least one of deliver/wake is required.',
    toolset: 'watchers',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: idSchema,
        kind: {
          type: 'string',
          enum: ['file', 'http', 'rss', 'process'],
          description: 'What to watch: a file path, an HTTP URL, an RSS/Atom feed, or a process.',
        },
        target: {
          type: 'string',
          description:
            'The watched target: file path (file), URL (http/rss), or pid-file path / process name / PID (process).',
        },
        interval_seconds: {
          type: 'number',
          description: `Poll interval in seconds. Minimum ${MIN_INTERVAL_SECONDS} (the scheduler ticks every 60s).`,
        },
        deliver: {
          type: 'object',
          description:
            'Deliver the change summary verbatim to an explicit channel target (no LLM turn).',
          properties: {
            platform: { type: 'string', description: 'Channel platform, e.g. "telegram".' },
            chat_id: { type: 'string', description: 'Explicit chat id on that platform.' },
          },
        },
        wake: {
          type: 'object',
          description: 'Wake a personality with the change summary as untrusted context.',
          properties: {
            personality_id: { type: 'string', description: 'Personality to wake.' },
            prompt_prefix: {
              type: 'string',
              description: 'Optional instruction prepended to the wake prompt.',
            },
          },
        },
      },
      required: ['id', 'kind', 'target', 'interval_seconds'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { id, kind, target, interval_seconds, deliver, wake } = args as {
        id?: string;
        kind?: WatcherKind;
        target?: string;
        interval_seconds?: number;
        deliver?: DeliverArg;
        wake?: WakeArg;
      };
      if (!id) return fail('id is required');
      if (!kind) return fail('kind is required');
      if (!target) return fail('target is required');
      if (interval_seconds === undefined) return fail('interval_seconds is required');
      if (!deliver && !wake) {
        return fail('at least one of deliver or wake is required');
      }

      // The creating turn, recorded so every later delivery can be re-checked
      // against this personality's policy (`WatcherManager.dispatchChange`).
      const owner: WatcherOwner | undefined = ctx.personalityId
        ? {
            personalityId: ctx.personalityId,
            ...(ctx.origin !== undefined ? { origin: ctx.origin } : {}),
          }
        : undefined;

      const onChange: WatcherOnChange = {};
      if (deliver) {
        if (!deliver.platform || !deliver.chat_id) {
          return fail('deliver requires explicit platform and chat_id');
        }
        const refusal = refuseForeignDeliver(opts.outbox, owner, deliver.platform, deliver.chat_id);
        if (refusal) return refusal;
        onChange.deliver = { platform: deliver.platform, chatId: deliver.chat_id };
      }
      if (wake) {
        if (!wake.personality_id) return fail('wake requires personality_id');
        onChange.wake = {
          personalityId: wake.personality_id,
          ...(wake.prompt_prefix ? { promptPrefix: wake.prompt_prefix } : {}),
        };
      }

      try {
        const record = await manager.createWatcher({
          id,
          kind,
          target,
          intervalSeconds: interval_seconds,
          onChange,
          ...(owner ? { owner } : {}),
        });
        return { ok: true, value: `Watcher created: ${formatWatcher(record)}` };
      } catch (err) {
        return fromError(err);
      }
    },
  };

  const listTool: Tool = {
    name: 'watcher_list',
    description: 'List all configured watchers with their kind, target, interval, and actions.',
    toolset: 'watchers',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      const watchers = await manager.listWatchers();
      if (watchers.length === 0) return { ok: true, value: 'No watchers configured.' };
      return { ok: true, value: watchers.map(formatWatcher).join('\n') };
    },
  };

  const lifecycleTool = (
    name: string,
    description: string,
    action: (id: string) => Promise<void>,
    pastTense: string,
  ): Tool => ({
    name,
    description,
    toolset: 'watchers',
    capabilities: {},
    schema: {
      type: 'object',
      properties: { id: idSchema },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id?: string };
      if (!id) return fail('id is required');
      try {
        await action(id);
        return { ok: true, value: `Watcher ${pastTense}: ${id}` };
      } catch (err) {
        return fromError(err);
      }
    },
  });

  return [
    createTool,
    listTool,
    lifecycleTool(
      'watcher_pause',
      'Pause a watcher. Its backing schedule is deregistered; last-seen state is kept so resuming continues detection from where it left off.',
      (id) => manager.pauseWatcher(id),
      'paused',
    ),
    lifecycleTool(
      'watcher_resume',
      'Resume a paused watcher. Detection continues against the state persisted before the pause.',
      (id) => manager.resumeWatcher(id),
      'resumed',
    ),
    lifecycleTool(
      'watcher_delete',
      'Delete a watcher, its backing schedule, and its persisted state.',
      (id) => manager.removeWatcher(id),
      'deleted',
    ),
  ];
}
