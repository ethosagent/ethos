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
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import {
  DEFAULT_WATCHER_MAX_FIRES,
  effectiveMaxFires,
  isForeignDeliverForGatedOwner,
  MAX_AGENT_WATCHER_FIRES,
  MIN_INTERVAL_SECONDS,
  type WatcherDeliveryGate,
  type WatcherKind,
  type WatcherLimits,
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
  const line = `${w.id} [${w.kind}] ${w.target} — every ${w.intervalSeconds}s, ${actions.join(', ')}, ${formatBudget(w)} (${status})`;
  const notes = [w.stopped?.reason, w.deliveryWithheld?.reason].filter(Boolean);
  return notes.length > 0 ? `${line}\n  ${notes.join('\n  ')}` : line;
}

/** The remaining fire budget and any expiry/cooldown, as `watcher_list` shows it. */
function formatBudget(w: WatcherRecord): string {
  const max = effectiveMaxFires(w);
  const used = w.firesUsed ?? 0;
  const parts = [
    max === 0 ? `${used} fires, unlimited` : `${Math.max(0, max - used)} of ${max} fires left`,
  ];
  if (w.limits?.cooldownSeconds) parts.push(`cooldown ${w.limits.cooldownSeconds}s`);
  if (w.limits?.expiresAt) parts.push(`expires ${w.limits.expiresAt}`);
  return parts.join(', ');
}

interface LimitsArg {
  expires_at?: string;
  cooldown_seconds?: number;
  max_fires?: number;
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
   * (`packages/wiring/src/compose-tools.ts`). Checked for EVERY `deliver`
   * target (S5), before the outbox refusal, whether or not the outbox gates the
   * owner. Absent = no allowlist applies.
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

// ---------------------------------------------------------------------------
// Only a person grows or refills an agent's watchers (plan
// personality-presence-and-initiative §5: "no watcher created by an agent can
// wake a personality without limit").
//
// `watcher_create`, `watcher_resume` and `watcher_delete` refuse unless
// `ToolContext.initiator === 'user'` — the same strict reading as `gateRefusal`
// in `packages/wiring/src/amendments.ts`: a watcher wake (`initiator: 'system'`,
// `initiatorFor` in `extensions/gateway/src/index.ts` and `runWatcherWakeTurn`
// in `apps/ethos/src/lib/watcher-wake.ts`), a cron turn
// (`apps/ethos/src/commands/cron-turn.ts`) and any surface that does not say
// who started it are all refused. `watcher_pause` and `watcher_list` stay open:
// they cannot add a fire. Pinned by "only a person-started turn grows or
// refills watchers" in `src/__tests__/limits.test.ts`.
//
// Why delete-then-recreate needs no per-id tombstone: without a person, the
// woken agent can neither delete nor create, so the loop that refilled a spent
// budget is gone. WITH a person, a tombstone keyed by id would be bypassed by
// the next id, so it would buy nothing; the bound there is the per-owner cap
// (`MAX_WATCHERS_PER_OWNER`, `WatcherManager.createWatcher`/`resumeWatcher`)
// times the per-watcher ceiling (`MAX_AGENT_WATCHER_FIRES`,
// `validateWatcherInput`) — fires that only a person-started turn can grant.
// ---------------------------------------------------------------------------

function personRequired(
  ctx: Pick<ToolContext, 'initiator'>,
  action: string,
): ToolResult | undefined {
  if (ctx.initiator === 'user') return undefined;
  return fail(
    `${action} needs a turn a person started. A watcher wake, a cron job or another ` +
      'system turn cannot create, resume or delete watchers — ask the person to do it. ' +
      '(watcher_pause and watcher_list still work.)',
  );
}

/**
 * Whether the calling turn may see and act on `watcher` (plan
 * personality-memory-boundary G1, verification round E6): its own
 * personality's watchers, and on a SHARED turn only those a shared turn
 * created (`owner.roomAudience === 'shared'`). A private watcher's target,
 * wake prompt and delivery chat are the owner's; a room must neither read
 * them nor pause, resume or delete the watcher. Pinned by
 * `src/__tests__/room-audience.test.ts`.
 */
function visibleTo(watcher: WatcherRecord, caller: string, shared: boolean): boolean {
  if (watcher.owner?.personalityId !== caller) return false;
  return !shared || watcher.owner.roomAudience === 'shared';
}

/**
 * The single ownership gate for pause/resume/delete: a watcher owned by another
 * personality — or by none — or, on a shared turn, a watcher no shared turn
 * created (`visibleTo`), returns the SAME result as an id that does not exist,
 * so the tools are not an existence oracle across personalities or audiences.
 */
async function loadOwnedWatcher(
  manager: WatcherManager,
  id: string,
  caller: string,
  shared: boolean,
): Promise<{ ok: true; watcher: WatcherRecord } | { ok: false; result: ToolResult }> {
  const watcher = await manager.getWatcher(id);
  if (!watcher || !visibleTo(watcher, caller, shared)) {
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
      'Create a declarative zero-token watcher. A deterministic differ (file hash, HTTP ETag/content, RSS GUIDs, process alive/dead) runs on a schedule with no LLM involvement; on a change it delivers a short summary to a channel and/or wakes a personality. At least one of deliver/wake is required. Every watcher has a fire budget (default ' +
      DEFAULT_WATCHER_MAX_FIRES +
      '); when it is spent, or the watcher expires, the watcher pauses.',
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
        limits: {
          type: 'object',
          description:
            'When the watcher stops: an expiry, a cooldown between fires, a fire budget.',
          properties: {
            expires_at: {
              type: 'string',
              description:
                'ISO-8601 date-time with a zone (Z or ±hh:mm), e.g. 2026-10-01T09:00:00Z, after which the watcher pauses.',
            },
            cooldown_seconds: {
              type: 'number',
              description: 'Minimum seconds between fires; changes inside it fire nothing.',
            },
            max_fires: {
              type: 'number',
              description: `Fires allowed before the watcher pauses. 1 to ${MAX_AGENT_WATCHER_FIRES}; default ${DEFAULT_WATCHER_MAX_FIRES}.`,
            },
          },
        },
      },
      required: ['id', 'kind', 'target', 'interval_seconds'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { id, kind, target, interval_seconds, deliver, wake, limits } = args as {
        id?: string;
        kind?: WatcherKind;
        target?: string;
        interval_seconds?: number;
        deliver?: DeliverArg;
        wake?: WakeArg;
        limits?: LimitsArg;
      };
      if (!ctx.personalityId) return PERSONALITY_REQUIRED;
      const notPerson = personRequired(ctx, 'watcher_create');
      if (notPerson) return notPerson;
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
        // A watcher a shared turn creates wakes shared (G1-6,
        // `WatcherManager.wakeAudience`).
        ...(ctx.roomAudience !== undefined ? { roomAudience: ctx.roomAudience } : {}),
      };

      const onChange: WatcherOnChange = {};
      if (deliver) {
        if (!deliver.platform || !deliver.chat_id) {
          return fail('deliver requires explicit platform and chat_id');
        }
        // Every target meets the allowlist `send_message` meets (S5), FIRST and
        // whatever the outbox says — the same order as `executeSendMessage` in
        // `@ethosagent/tools-messaging` (O-D3): the outbox exempts a gated
        // owner's origin chat and the operator's chat, and that exemption must
        // never widen the destinations the operator allowed. Pinned by "a gated
        // owner's origin chat outside the allowlist is refused" in
        // `src/__tests__/ownership.test.ts`.
        const notAllowed = messagingTargetRefusal(
          opts.getAllowedTargets,
          caller,
          deliver.platform,
          deliver.chat_id,
        );
        if (notAllowed) return fail(notAllowed);
        const refusal = refuseForeignDeliver(opts.outbox, owner, deliver.platform, deliver.chat_id);
        if (refusal) return refusal;
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

      // An agent never creates an unlimited watcher (plan
      // personality-presence-and-initiative §5). `validateWatcherInput` also
      // refuses `maxFires: 0` for any record with an owner, which this tool
      // always stamps.
      if (limits?.max_fires === 0) {
        return fail(
          'limits.max_fires must be at least 1 — an unlimited watcher can only be created by the operator',
        );
      }
      if (limits?.max_fires !== undefined && limits.max_fires > MAX_AGENT_WATCHER_FIRES) {
        return fail(
          `limits.max_fires must be at most ${MAX_AGENT_WATCHER_FIRES} for a watcher an agent creates`,
        );
      }
      const watcherLimits: WatcherLimits = {
        ...(limits?.expires_at !== undefined ? { expiresAt: limits.expires_at } : {}),
        ...(limits?.cooldown_seconds !== undefined
          ? { cooldownSeconds: limits.cooldown_seconds }
          : {}),
        ...(limits?.max_fires !== undefined ? { maxFires: limits.max_fires } : {}),
      };

      try {
        const record = await manager.createWatcher({
          id,
          kind,
          target,
          intervalSeconds: interval_seconds,
          onChange,
          owner,
          limits: watcherLimits,
        });
        return { ok: true, value: `Watcher created: ${formatWatcher(record)}` };
      } catch (err) {
        return fromError(err);
      }
    },
  };

  const listTool: Tool = {
    name: 'watcher_list',
    description:
      "List this personality's watchers with their kind, target, interval, actions, remaining fire budget, and why a stopped watcher stopped.",
    toolset: 'watchers',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, ctx): Promise<ToolResult> {
      if (!ctx.personalityId) return PERSONALITY_REQUIRED;
      const caller = ctx.personalityId;
      const shared = ctx.roomAudience === 'shared';
      const watchers = (await manager.listWatchers()).filter((w) => visibleTo(w, caller, shared));
      if (watchers.length === 0) return { ok: true, value: 'No watchers configured.' };
      return { ok: true, value: watchers.map(formatWatcher).join('\n') };
    },
  };

  const lifecycleTool = (
    name: string,
    description: string,
    action: (id: string) => Promise<void>,
    pastTense: string,
    personOnly: boolean,
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
      const notPerson = personOnly ? personRequired(ctx, name) : undefined;
      if (notPerson) return notPerson;
      const { id } = args as { id?: string };
      if (!id) return fail('id is required');
      const owned = await loadOwnedWatcher(
        manager,
        id,
        ctx.personalityId,
        ctx.roomAudience === 'shared',
      );
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
      false,
    ),
    lifecycleTool(
      'watcher_resume',
      'Resume a paused watcher. Detection continues against the state persisted before the pause.',
      (id) => manager.resumeWatcher(id),
      'resumed',
      true,
    ),
    lifecycleTool(
      'watcher_delete',
      'Delete a watcher, its backing schedule, and its persisted state.',
      (id) => manager.removeWatcher(id),
      'deleted',
      true,
    ),
  ];
}
