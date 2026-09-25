// Agent-callable watcher lifecycle tools (toolset: 'watchers').
//
// A personality whose toolset includes 'watchers' can own declarative
// zero-token watchers — the deterministic differ runs on the cron
// scheduler's tick with no LLM involvement; the agent is only woken (or a
// channel notified) on a real change. Access is toolset membership; each record
// is owned by the personality that created it (`WatcherRecord.owner`, scoped by
// `loadOwnedWatcher` below) — nothing is added to PersonalityConfig (plan
// gap-event-triggers §3e).

import { type MessagingToolsOptions, messagingTargetRefusal } from '@ethosagent/tools-messaging';
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
  /**
   * The operator messaging allowlist — the same closure `send_message` gets
   * (`packages/wiring/src/compose-tools.ts`). Checked for a `deliver` target
   * whose owner the outbox does not gate (S5); a gated owner's foreign target is
   * already refused by `refuseForeignDeliver`. Absent = no allowlist applies.
   */
  getAllowedTargets?: MessagingToolsOptions['getAllowedTargets'];
}

// ---------------------------------------------------------------------------
// Ownership (S5, plan openclaw-2026.9.6-gaps) — mirrors `loadOwnedJob` in
// `@ethosagent/tools-cron`. Every tool needs a personality context; list shows
// only the caller's watchers; pause/resume/delete go through `loadOwnedWatcher`,
// and a wake names the caller. Pinned by `src/__tests__/ownership.test.ts`.
//
// Limitations: a record with no `owner` (written before owners were recorded)
// belongs to no personality, so no agent can see or change it — only an edit of
// `watchers.json` removes it. The allowlist is checked at creation only; a
// watcher created before an allowlist entry was narrowed keeps delivering (the
// delivery-time re-check in `WatcherManager.dispatchChange` covers the outbox
// policy and the wake owner, not the allowlist). `watcher_create`'s "already
// exists" refusal is global by id, so it reveals that SOME watcher holds an id.
// ---------------------------------------------------------------------------

const PERSONALITY_REQUIRED: ToolResult = fail('watchers require a personality context');

/**
 * The single ownership gate for pause/resume/delete: a watcher owned by another
 * personality — or by none — returns the SAME result as an id that does not
 * exist, so the tools are not an existence oracle across personalities.
 */
async function loadOwnedWatcher(
  manager: WatcherManager,
  id: string,
  caller: string,
): Promise<{ ok: true; watcher: WatcherRecord } | { ok: false; result: ToolResult }> {
  const watcher = await manager.getWatcher(id);
  if (!watcher || watcher.owner?.personalityId !== caller) {
    return { ok: false, result: fail(`Watcher not found: ${id}`) };
  }
  return { ok: true, watcher };
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
      if (!ctx.personalityId) return PERSONALITY_REQUIRED;
      const caller = ctx.personalityId;
      if (!id) return fail('id is required');
      if (!kind) return fail('kind is required');
      if (!target) return fail('target is required');
      if (interval_seconds === undefined) return fail('interval_seconds is required');
      if (!deliver && !wake) {
        return fail('at least one of deliver or wake is required');
      }

      // The creating turn, recorded so every later delivery can be re-checked
      // against this personality's policy (`WatcherManager.dispatchChange`).
      const owner: WatcherOwner = {
        personalityId: caller,
        ...(ctx.origin !== undefined ? { origin: ctx.origin } : {}),
      };

      const onChange: WatcherOnChange = {};
      if (deliver) {
        if (!deliver.platform || !deliver.chat_id) {
          return fail('deliver requires explicit platform and chat_id');
        }
        const refusal = refuseForeignDeliver(opts.outbox, owner, deliver.platform, deliver.chat_id);
        if (refusal) return refusal;
        // An owner the outbox gates on this platform was answered above; any
        // other owner meets the allowlist `send_message` meets (S5).
        if (!opts.outbox?.gates(caller, deliver.platform)) {
          const notAllowed = messagingTargetRefusal(
            opts.getAllowedTargets,
            caller,
            deliver.platform,
            deliver.chat_id,
          );
          if (notAllowed) return fail(notAllowed);
        }
        onChange.deliver = { platform: deliver.platform, chatId: deliver.chat_id };
      }
      if (wake) {
        if (!wake.personality_id) return fail('wake requires personality_id');
        // A wake is always self: another personality's id would run this
        // turn's prompt_prefix as an instruction turn with that personality's
        // toolset. Re-checked at fire time by `WatcherManager.dispatchChange`.
        if (wake.personality_id !== caller) {
          return fail(
            `wake.personality_id must be the calling personality ("${caller}") — a watcher can only wake the personality that created it`,
          );
        }
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
          owner,
        });
        return { ok: true, value: `Watcher created: ${formatWatcher(record)}` };
      } catch (err) {
        return fromError(err);
      }
    },
  };

  const listTool: Tool = {
    name: 'watcher_list',
    description: "List this personality's watchers with their kind, target, interval, and actions.",
    toolset: 'watchers',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, ctx): Promise<ToolResult> {
      if (!ctx.personalityId) return PERSONALITY_REQUIRED;
      const caller = ctx.personalityId;
      const watchers = (await manager.listWatchers()).filter(
        (w) => w.owner?.personalityId === caller,
      );
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
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.personalityId) return PERSONALITY_REQUIRED;
      const { id } = args as { id?: string };
      if (!id) return fail('id is required');
      const owned = await loadOwnedWatcher(manager, id, ctx.personalityId);
      if (!owned.ok) return owned.result;
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
