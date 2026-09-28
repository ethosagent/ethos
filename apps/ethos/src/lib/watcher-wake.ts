// The watcher wake, shared by the three processes that own a WatcherManager
// (`ethos gateway start`, `ethos boot`, `ethos serve`), so the room audience a
// wake carries (plan personality-memory-boundary step 5, G1-6) is set in one
// place. Pinned by `apps/ethos/src/__tests__/watcher-audience.test.ts`.

import type { AgentLoop } from '@ethosagent/core';
import type { AgentEvent, InboundMessage } from '@ethosagent/types';
import type { WatcherWakeEvent } from '@ethosagent/watchers';
import { sanitize, wrapUntrusted } from '@ethosagent/wiring';

/**
 * The prompt a woken turn sees. The diff summary is external observation —
 * wrapped as untrusted content and the assembled prompt sanitized before it
 * enters the loop (same treatment as the cron precheck path).
 */
export function watcherWakePrompt(event: WatcherWakeEvent): string {
  const wrapped = wrapUntrusted({
    content: event.summary,
    toolName: 'watcher',
    source: `${event.watcherId}:${event.target}`,
  });
  return sanitize(
    `${event.promptPrefix ?? 'A watcher you own detected a change.'}\n\n${wrapped.content}`,
  );
}

/**
 * The synthetic inbound a gateway-role wake (`ethos gateway start`, `ethos
 * boot`) hands `Gateway.handleMessage` on the owning personality's bot.
 * `isDm: true` keeps routing it like a DM; a shared wake
 * (`WatcherManager.wakeAudience`) carries `audienceHint: 'shared'`, which
 * `Gateway.audienceFor` reads — the watcher came from, or reports to, a room.
 */
export function watcherWakeMessage(event: WatcherWakeEvent, botKey: string): InboundMessage {
  return {
    platform: 'watcher',
    chatId: `watcher:${event.watcherId}`,
    text: watcherWakePrompt(event),
    isDm: true,
    isGroupMention: false,
    botKey,
    messageId: `watcher-${event.watcherId}-${Date.now()}`,
    raw: { watcherId: event.watcherId, target: event.target },
    ...(event.roomAudience === 'shared' ? { audienceHint: 'shared' as const } : {}),
  };
}

/**
 * `ethos serve`'s wake: no channel adapters, so the loop runs directly in a
 * fresh `watcher:<id>:<iso>` session, under the wake's own audience.
 */
export function runWatcherWakeTurn(
  loop: Pick<AgentLoop, 'run'>,
  event: WatcherWakeEvent,
): AsyncIterable<AgentEvent> {
  return loop.run(watcherWakePrompt(event), {
    sessionKey: `watcher:${event.watcherId}:${new Date().toISOString()}`,
    personalityId: event.personalityId,
    roomAudience: event.roomAudience,
    initiator: 'system',
  });
}

/**
 * The call-capture daemon's wake binding. Its event is a watcher wake without
 * an audience: a call capture is the owner's own call audit trail, private by
 * design (the plan's "private, no change" list), so it rides the watcher wake
 * path as `'private'`.
 */
export function callCaptureWake(
  wake: (event: WatcherWakeEvent) => Promise<void>,
): (event: Omit<WatcherWakeEvent, 'roomAudience'>) => Promise<void> {
  return (event) => wake({ ...event, roomAudience: 'private' });
}
