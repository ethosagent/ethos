// Post-call summary — on call end, summarize the conversation and post it to a
// paired text channel (plan/phases/gap-voice-realtime.md §4 Phase C).
//
// The summary flows through `adapter.sendArtifactMessage()` -> the injected
// `sendArtifact` sink, which in production is the gateway's single deduped
// `send()` gate (MessageDedupCache). This is the SAME path every outbound
// channel message uses — NEVER a new adapter-local dedup layer (see the adapter
// README dedup boundary note).

import type { VoiceChannelAdapter } from '../adapter';

export interface PostCallSummaryDeps {
  /**
   * Custom summarizer over the honest played transcript. Defaults to a
   * deterministic one-line summary; an LLM-backed summarizer can be injected
   * here without changing the send path.
   */
  summarize?: (input: { callerId: string; lastReplyText: string }) => string | Promise<string>;
}

/**
 * Returns a call-end handler that builds a summary from the adapter's honest
 * transcript (`lastReplyText()` — includes the `[interrupted]` marker on
 * barge-in) and posts it via `adapter.sendArtifactMessage()`. A no-op (from the
 * adapter's side) when no `sendArtifact` sink was wired.
 */
export function createPostCallSummary(
  deps: PostCallSummaryDeps = {},
): (adapter: VoiceChannelAdapter) => Promise<void> {
  return async (adapter: VoiceChannelAdapter): Promise<void> => {
    const lastReplyText = adapter.lastReplyText();
    const summary = deps.summarize
      ? await deps.summarize({ callerId: adapter.callerId, lastReplyText })
      : defaultCallSummary(adapter.callerId, lastReplyText);
    await adapter.sendArtifactMessage(summary);
  };
}

function defaultCallSummary(callerId: string, lastReplyText: string): string {
  const body = lastReplyText.trim() || '(no reply was spoken)';
  return `Call summary — ${callerId}: ${body}`;
}
