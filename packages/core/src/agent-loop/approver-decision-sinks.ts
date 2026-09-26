// The approver's private channel to the turn's decision sink (plan
// decision-provider-personality §15.3, PD16).
//
// The router and the injection classifier receive their sink on their seam
// input, and only the composition root supplies those functions. The approver
// is different: it runs inside the `before_tool_call` hook, and ANY handler of
// that hook — a third-party plugin's included — sees the hook payload. A sink
// on the payload would let any handler write a `decision` row with arbitrary
// verdict text into the user's trail (fake "✓ decided" assurance, K8). So the
// sink is not on the payload. Core binds it here, keyed by the call, for
// exactly the span of the `before_tool_call` fire (`enforceBeforeToolCall`,
// ./stages/per-call-enforcement.ts), and the smart approver looks it up by the
// payload's `sessionId` + `toolCallId`.
//
// Who can reach it: the object is injected at construction
// (`AgentLoopConfig.approverDecisionSinks`) and handed to the approver by the
// composition root (`SmartApproverDecisionSite.sinks`, packages/wiring). A
// plugin receives neither the loop config nor the approver's site, so it has
// no path to `get`. Pinned by `../__tests__/decision-events.test.ts`
// ("a plugin before_tool_call handler cannot reach a sink").

import type { DecisionSink } from '@ethosagent/types';

export class ApproverDecisionSinks {
  private readonly live = new Map<string, DecisionSink>();

  /**
   * Core only: make `sink` the one `get` returns for this call until the
   * returned release runs. Release removes only its own binding.
   */
  bind(sessionId: string, toolCallId: string, sink: DecisionSink): () => void {
    const key = keyOf(sessionId, toolCallId);
    this.live.set(key, sink);
    return () => {
      if (this.live.get(key) === sink) this.live.delete(key);
    };
  }

  /** The sink core bound for this call while its `before_tool_call` fires, if any. */
  get(sessionId: string, toolCallId: string): DecisionSink | undefined {
    return this.live.get(keyOf(sessionId, toolCallId));
  }
}

function keyOf(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}
