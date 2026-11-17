// Room-audience decisions for gateway turns (plan personality-memory-boundary),
// moved out of index.ts (Context Budget 3, Task 2). `Gateway` constructs one
// `GatewayAudience` and keeps a delegating method under every cited name
// (`Gateway.audienceFor`). It owns no state: every input is read live through
// `deps` from the fields `Gateway` owns.

import { isSharedSession, type PrivateChatSet, targetAudience } from '@ethosagent/core';
import { jobRoomAudience } from '@ethosagent/job-runner';
import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import type { BackgroundJob, InboundMessage, SessionStore, TurnAudience } from '@ethosagent/types';
import { senderIsOwner } from './gateway-pure';

/** What `GatewayAudience` reads from `Gateway`; getters, so every read is live. */
export interface AudienceDeps {
  readonly privateChats: PrivateChatSet | undefined;
  readonly channelFilter: ChannelFilterConfig | undefined;
  readonly sessionStoreFor: (() => SessionStore) | undefined;
}

export class GatewayAudience {
  constructor(private readonly deps: AudienceDeps) {}

  /**
   * The room audience of whatever `message` starts (plan
   * personality-memory-boundary G1): `'private'` for a DM the adapter did not
   * hint shared (`InboundMessage.audienceHint`, D10), or for a room the
   * operator listed in `gateway.private_chats.<platform>` (`privateChats`,
   * D9); `'shared'` otherwise. Keyed on `chatId`, never `threadId`, so a thread
   * inherits its parent chat's audience. The ONE place the gateway decides it:
   * every user turn (`enqueueTurn` → `runTurn`), `/learn` (D17) and the
   * `/background` job stamp read it. Independent of `isDm`'s other jobs
   * (admission, engagement, approval binding), which are unchanged. Pinned by
   * `__tests__/memory-boundary-e2e.test.ts` and "stamps the job … when
   * launched from …" in `__tests__/background-wake.test.ts`.
   */
  audienceFor(message: InboundMessage): TurnAudience {
    if (message.isDm && message.audienceHint !== 'shared') return 'private';
    return this.deps.privateChats?.has(message.platform, message.chatId) ? 'private' : 'shared';
  }

  /**
   * D8 — a DM from someone other than `channel_filter.<platform>.ownerUserId`,
   * on a platform that has one. `MEMORY.md` is the owner's, so the turn runs
   * with personality memory withheld while the sender's own `user:<id>`
   * profile is still read (`RunOptions.skipPersonalityMemory`, enforced by
   * `withPersonalityMemoryWithheld` in packages/core/src/agent-loop/audience.ts).
   * No owner configured → false: the plan's rule has nothing to compare
   * against. Pinned by `__tests__/memory-boundary-e2e.test.ts`.
   */
  withholdsPersonalityMemory(message: InboundMessage): boolean {
    if (!message.isDm) return false;
    const owner = this.deps.channelFilter?.[message.platform]?.ownerUserId;
    if (owner === undefined || owner === '') return false;
    return !senderIsOwner(message, owner);
  }

  /**
   * The audience a turn started by `message` runs under, D8 included: a
   * non-owner DM is `'shared'` here. Used where the audience is PERSISTED on
   * something that later runs on its own (a `/background` job, whose child has
   * no sender to keep a `user:<id>` read for).
   */
  jobAudienceFor(message: InboundMessage): TurnAudience {
    return this.withholdsPersonalityMemory(message) ? 'shared' : this.audienceFor(message);
  }

  /**
   * Whether the lane's session already runs shared (`isSharedSession`,
   * @ethosagent/core — its stamp, else its key shape), read through
   * `GatewayConfig.sessionStore`. With no store, or no session yet, the origin
   * chat itself is judged (`targetAudience`, honouring `privateChats`). Used
   * only to keep a shared wake review out of a private lane's session
   * (`runTurn`).
   */
  async laneSessionIsShared(sessionKey: string, message: InboundMessage): Promise<boolean> {
    const store = this.deps.sessionStoreFor?.();
    const session = store ? await store.getSessionByKey(sessionKey).catch(() => null) : null;
    if (session) return isSharedSession(session, this.deps.privateChats);
    return targetAudience(message.platform, message.chatId, this.deps.privateChats) === 'shared';
  }

  /**
   * A wake review's audience: the job's (`jobRoomAudience` — its stamp, or a
   * legacy row's origin chat). The review message is synthetic (`isDm:
   * false`), so `audienceFor` would call every review shared; the job is the
   * record of where the work came from. Pinned by the room-audience cases in
   * `__tests__/parent-review.test.ts`.
   */
  reviewAudience(job: BackgroundJob): TurnAudience {
    return jobRoomAudience(job);
  }

  // @@METHODS@@
}
