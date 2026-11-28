import { ethosDir } from '@ethosagent/config';
import type { NotifyOutcome } from '@ethosagent/gateway';
import type { InitiativeActionVerb, InitiativeDigest, Storage } from '@ethosagent/types';
import {
  createInitiativeCliPort,
  type DecideGate,
  type DigestNotify,
  decideInitiative,
  type InitiativeCliPort,
  renderBriefMarkdown,
} from '@ethosagent/wiring';
import { getStorage } from '../wiring';
import { latestBrief } from './initiative-briefs';
import { setInitiativeDigestNotify } from './initiative-tick';

// The app layer's half of the channel buttons on the initiative digest and options brief
// (plan Task 6.5). The adapters (`platform-telegram`, `platform-slack`) parse a tap with
// `parseInitiativeAction` and hand it here; this module owns WHO may tap and WHAT it does:
//
//  - Who: only `channel_filter.<platform>.ownerUserId` (the outbox's rule, O-D5). Anyone else is
//    told no and nothing is written. Pinned by initiative-wiring.test.ts ('non-owner tap refused').
//  - What: a decision goes through `decideInitiative`, the one decision function the CLI and the
//    web service share, as `owner:<platform>:<userId>`. Pinned by initiative-wiring.test.ts
//    ('adopt button records gate2 adopt and closes the exploration').

/** What an adapter hands over, normalised: `say` is the short answer, `send` a longer message. */
export interface InitiativeTap {
  verb: InitiativeActionVerb;
  /** A ledger id (an exploration or an initiative), never text a model wrote. */
  target: string;
  userId: string | undefined;
  say(text: string): Promise<void>;
  /** Resolves false when the message did not go out. */
  send(text: string): Promise<boolean>;
}

export interface InitiativeTapDeps {
  /** A fresh port per tap (the caller closes nothing: this module closes it). Null: no ledger yet. */
  port(): Promise<InitiativeCliPort | null>;
  /** `channel_filter.<platform>.ownerUserId`. */
  ownerTarget(platform: string): string | undefined;
  now?: () => Date;
}

const GATE: Partial<Record<InitiativeActionVerb, DecideGate>> = {
  approve: 'gate1_explore',
  reject: 'gate1_explore',
  snooze: 'gate1_explore',
  adopt: 'gate2_adopt',
  dig_deeper: 'gate2_adopt',
  park: 'gate2_adopt',
  keep: 'self_start',
  make_mine: 'self_start',
  stop: 'self_start',
};

const DONE: Partial<Record<InitiativeActionVerb, string>> = {
  approve: 'Approved. It starts exploring.',
  reject: 'Dropped. It will not explore this.',
  snooze: 'Snoozed.',
  adopt: 'Adopted.',
  dig_deeper: 'Digging deeper.',
  park: 'Parked.',
  keep: 'Kept.',
  stop: 'Stopped.',
};

/** Builds the tap handler; the platform is the adapter's own, never read from the payload. */
export function createInitiativeTapHandler(
  deps: InitiativeTapDeps,
): (platform: string, tap: InitiativeTap) => Promise<void> {
  return async (platform, tap) => {
    const owner = deps.ownerTarget(platform);
    if (owner === undefined || tap.userId === undefined || tap.userId !== owner) {
      await tap.say('Only the owner can decide this.');
      return;
    }
    const port = await deps.port();
    if (!port) {
      await tap.say('No initiatives saved yet.');
      return;
    }
    try {
      await apply(port, platform, tap, deps.now?.() ?? new Date());
    } finally {
      port.close();
    }
  };
}

async function apply(
  port: InitiativeCliPort,
  platform: string,
  tap: InitiativeTap,
  now: Date,
): Promise<void> {
  if (tap.verb === 'edit') {
    await tap.say('Tell the agent in chat what to change.');
    return;
  }
  if (tap.verb === 'copy_md') {
    const e = port.store.getExploration(tap.target);
    const detail = e ? port.store.get(e.initiativeId) : null;
    const brief = latestBrief(detail?.briefs ?? [], tap.target);
    if (!e || !brief) {
      await tap.say(`${tap.target} has no brief yet.`);
      return;
    }
    const sent = await tap.send(
      renderBriefMarkdown({
        question: e.question,
        bodyMd: brief.bodyMd,
        recommendedOption: brief.recommendedOption,
        findings: (detail?.findings ?? []).filter((f) => f.explorationId === e.id),
      }),
    );
    await tap.say(
      sent
        ? 'Sent as Markdown.'
        : `Could not send the brief here; run \`ethos initiatives show ${e.initiativeId}\`.`,
    );
    return;
  }
  const gate = GATE[tap.verb];
  if (!gate) {
    await tap.say('Unrecognised button.');
    return;
  }
  // Adopt takes the option the brief recommends: the button carries only the exploration id.
  const option =
    tap.verb === 'adopt'
      ? latestBrief(
          port.store.get(port.store.getExploration(tap.target)?.initiativeId ?? '')?.briefs ?? [],
          tap.target,
        )?.recommendedOption
      : undefined;
  const result = await decideInitiative(
    port,
    { target: tap.target, gate, verdict: tap.verb, ...(option ? { option } : {}) },
    { decidedBy: `owner:${platform}:${tap.userId}`, now },
  );
  if (!result.ok) {
    await tap.say(result.message);
    return;
  }
  if (result.makeMine) {
    await tap.say(`To make ${tap.target} yours, tell the agent in chat.`);
    return;
  }
  await tap.say(DONE[tap.verb] ?? 'Done.');
}

/** The one place the host builds the port: a fresh read of `initiatives.db` per tap. */
export const initiativePortFor =
  (storage: Storage, dataDir: string): InitiativeTapDeps['port'] =>
  () =>
    createInitiativeCliPort({ storage, dataDir });

interface InitiativeCapableAdapter {
  id: string;
  onInitiativeAction(
    handler: (event: {
      verb: InitiativeActionVerb;
      target: string;
      userId: string | undefined;
      answer?: (text?: string) => Promise<void>;
      reply: (text: string) => Promise<boolean>;
    }) => void | Promise<void>,
  ): void;
}

const isInitiativeCapable = <T extends { id: string }>(a: T): a is T & InitiativeCapableAdapter =>
  typeof (a as Partial<InitiativeCapableAdapter>).onInitiativeAction === 'function';

/** Register the handler on every adapter that renders initiative buttons; returns how many. */
export function wireInitiativeAdapters(
  handler: (platform: string, tap: InitiativeTap) => Promise<void>,
  adapters: Iterable<{ id: string }>,
): number {
  let wired = 0;
  for (const adapter of adapters) {
    if (!isInitiativeCapable(adapter)) continue;
    const platform = adapter.id.split(':')[0] ?? adapter.id;
    adapter.onInitiativeAction((e) =>
      handler(platform, {
        verb: e.verb,
        target: e.target,
        userId: e.userId,
        say: async (text) => {
          if (e.answer) await e.answer(text);
          else await e.reply(text);
        },
        send: e.reply,
      }),
    );
    wired++;
  }
  return wired;
}

/** What `Gateway` offers the digest send. Structural, like `CronDeliverDeps.gateway`. */
export interface DigestGateway {
  notifyTrackedOutcome(
    target: { platform: string; chatId: string; botKey?: string },
    text: string,
    extra?: { initiativeDigest?: InitiativeDigest },
  ): Promise<NotifyOutcome>;
  listAdapters(): ReadonlyArray<{ id: string }>;
}

/**
 * The digest sender: `Gateway.notifyTrackedOutcome`, which rides the delivery ledger and holds the notice
 * for quiet hours (extensions/gateway/src/__tests__/notify-tracked.test.ts, U11). The recipient is
 * the `<platform>:<chatId>` from the personality's `delivery.ownerChannel`; nothing a model wrote
 * reaches it. With more than one bot on the platform the bot is ambiguous, so the send is refused
 * (returns false) rather than going out as the wrong bot (pinned by initiative-wiring.test.ts).
 * The digest rides along so a card-capable adapter (Slack, Telegram) renders `digestBlocks` /
 * `digestCard` with the `init:` buttons that `createInitiativeTapHandler` answers; the Markdown
 * text, one CLI command per action, is the ledger's content and the fallback. Limitation: a notice
 * held for quiet hours and a ledger redelivery carry only that text, so they arrive without buttons.
 */
export function createDigestNotify(gateway: DigestGateway): DigestNotify {
  return async (target, text, digest) => {
    const ids = [
      ...new Set(
        gateway
          .listAdapters()
          .map((a) => a.id)
          .filter((id) => id === target.platform || id.startsWith(`${target.platform}:`)),
      ),
    ];
    const only = ids[0];
    if (only === undefined || ids.length > 1) return false;
    const colon = only.indexOf(':');
    const botKey = colon > 0 ? only.slice(colon + 1) : undefined;
    const outcome = await gateway.notifyTrackedOutcome(
      { ...target, ...(botKey ? { botKey } : {}) },
      text,
      digest ? { initiativeDigest: digest } : undefined,
    );
    return outcome === 'confirmed' ? true : outcome === 'failed' ? false : outcome;
  };
}

/**
 * One call for both gateway roots (`commands/gateway.ts`, `commands/boot.ts`): hands the tick its
 * digest sender and returns `wire`, which registers the tap handler on every adapter with
 * initiative buttons (call it for the first adapters and for each one added later).
 */
export function bindInitiativeHost(deps: {
  storage: Storage;
  dataDir: string;
  gateway: DigestGateway;
  ownerTarget(platform: string): string | undefined;
  setDigestNotify(notify: DigestNotify): void;
}): (adapters: Iterable<{ id: string }>) => number {
  deps.setDigestNotify(createDigestNotify(deps.gateway));
  const handler = createInitiativeTapHandler({
    port: initiativePortFor(deps.storage, deps.dataDir),
    ownerTarget: deps.ownerTarget,
  });
  return (adapters) => wireInitiativeAdapters(handler, adapters);
}

/** The gateway roots' one-liner: binds the digest sender and taps with the app's own storage and config. */
export function bindInitiativeHostFor(
  gateway: DigestGateway,
  config: { channelFilter?: Record<string, { ownerUserId?: string } | undefined> | undefined },
  adapters: Iterable<{ id: string }>,
): (adapters: Iterable<{ id: string }>) => number {
  const wire = bindInitiativeHost({
    storage: getStorage(),
    dataDir: ethosDir(),
    gateway,
    ownerTarget: (platform) => config.channelFilter?.[platform]?.ownerUserId,
    setDigestNotify: setInitiativeDigestNotify,
  });
  wire(adapters);
  return wire;
}
