// What `## Decisions` on the character sheet — and the per-personality lines
// of `ethos doctor` — say about one personality's decision sites (plan
// decision-provider-personality §4.5, §8). The web's `personalities.characterSheet`
// RPC renders the same artifact from the same function.
//
// Asks the enforcer rather than restating its rule: every site line comes from
// `resolvePersonalityDecisionSite` (packages/config/src/decisions.ts), the
// function the three live sites call per call, so a surface cannot claim a
// mode the turn would not run. The two annotations that function leaves to its
// callers (plan §4.4) are added here: a missing key, and an approver that is
// enabled under an `approvalMode` that never consults it.

import {
  DECISION_SITES,
  DECISIONS_API_KEY_REF,
  type DecisionsConfig,
  decisionToolEnabled,
  resolveDecisionsConfig,
  resolvePersonalityDecisionSite,
} from '@ethosagent/config';
import type { CharacterSheetDecisions } from '@ethosagent/personalities';
import type { PersonalityConfig, SecretsResolver } from '@ethosagent/types';

/**
 * The resolved `## Decisions` context for one personality, or `undefined` when
 * it declares no `decisions` block (the section is then not rendered, and
 * doctor does not list it).
 *
 * The vault is read only when the personality names the provider the operator
 * configured — a personality that cannot send anything costs no secret read.
 * An unreadable vault counts as no key, the posture `checkDecisionLayer` in
 * `apps/ethos/src/commands/doctor.ts` already takes.
 *
 * `inertApprovalMode` mirrors the approver's own gate: the smart approver is
 * consulted only when `safety.approvalMode` is `smart`, defaulting to `manual`
 * (`packages/wiring/src/danger-predicate.ts`, `safety?.approvalMode ?? 'manual'`).
 */
export async function resolveCharacterSheetDecisions(
  personality: PersonalityConfig,
  config: { decisions?: DecisionsConfig } | null | undefined,
  secrets: Pick<SecretsResolver, 'get'>,
): Promise<CharacterSheetDecisions | undefined> {
  const declared = personality.decisions;
  if (!declared) return undefined;
  const global = config?.decisions ? resolveDecisionsConfig(config.decisions) : undefined;
  const provider = declared.provider?.trim() || undefined;
  // The `decide` tool's own gate (plan decision-tool D6/D15), so the sheet's
  // `tool: decide` line cannot claim a tool the loop hides.
  const configured = decisionToolEnabled(declared, global);
  const approvalMode = personality.safety?.approvalMode ?? 'manual';

  const sites = DECISION_SITES.map((site) => {
    const r = resolvePersonalityDecisionSite(declared, site, global);
    return {
      site,
      requested: r.requested,
      effective: r.effective,
      ...(r.reason ? { reason: r.reason } : {}),
      missingThresholds: r.missingThresholds,
      ...(site === 'approver' && r.requested !== 'off' && approvalMode !== 'smart'
        ? { inertApprovalMode: approvalMode }
        : {}),
    };
  });

  const out: CharacterSheetDecisions = {
    ...(provider !== undefined ? { provider } : {}),
    configured,
    sites,
  };
  if (configured && global) {
    const key = await secrets.get(DECISIONS_API_KEY_REF).catch(() => null);
    // `buildDecisionsConfig` only keeps a baseUrl `new URL` accepts.
    out.host = new URL(global.baseUrl).host;
    out.model = global.model;
    out.apiKeyRef = DECISIONS_API_KEY_REF;
    out.apiKeyPresent = key !== null && key.trim().length > 0;
  }
  return out;
}
