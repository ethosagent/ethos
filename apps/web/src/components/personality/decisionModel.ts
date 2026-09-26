// The pure half of `DecisionModelField` (./DecisionModelField.tsx): the form
// value, the save patch, the select's options and the notes under each row.
// No React, no RPC.
//
// Nothing here resolves a site or decides a note's condition. Every note is
// read from `Personality.decisions.resolved`, which web-api fills from
// `resolveCharacterSheetDecisions` (@ethosagent/wiring) — the resolver the
// character sheet's `## Decisions` section and `ethos doctor` use, which calls
// `resolvePersonalityDecisionSite` (@ethosagent/config) and adds the missing-key
// and inert-approver annotations. A resolution describes what is SAVED, so a
// note shows only while its row still shows the saved value; saving refetches
// the personality and the notes with it.

import {
  DecisionProviderIdSchema,
  type DecisionProviderView,
  type Personality,
} from '@ethosagent/web-contracts';
import type { z } from 'zod';

export type DecisionSiteId = 'injection' | 'approver' | 'router';
export type DecisionSiteMode = 'off' | 'shadow' | 'on';

/** What the field holds: `provider` `''` is "None". Every site has a mode (`off` when unset). */
export interface DecisionFieldValue {
  provider: string;
  sites: Record<DecisionSiteId, DecisionSiteMode>;
}

export const DECISION_SITE_MODES: readonly DecisionSiteMode[] = ['off', 'shadow', 'on'];

/** The three rows, in the order the character sheet lists them. */
export const DECISION_SITE_ROWS: ReadonlyArray<{
  site: DecisionSiteId;
  label: string;
  help: string;
}> = [
  {
    site: 'injection',
    label: 'Injection check',
    help: 'Asks whether a tool result is trying to instruct the agent.',
  },
  {
    site: 'approver',
    label: 'Tool approvals',
    help: 'Asks whether a flagged tool call runs, is refused, or waits for you.',
  },
  {
    site: 'router',
    label: 'Model routing',
    help: 'Asks whether a message needs only the trivial model. Never routes up.',
  },
];

type StoredDecisions = Personality['decisions'];

/** The field's value for a stored `decisions` block (absent → None, every site off). */
export function decisionFieldValue(stored: StoredDecisions): DecisionFieldValue {
  return {
    provider: stored?.provider ?? '',
    sites: {
      injection: stored?.sites?.injection ?? 'off',
      approver: stored?.sites?.approver ?? 'off',
      router: stored?.sites?.router ?? 'off',
    },
  };
}

/**
 * The `personalities.update` `decisions` patch for a touched field.
 *
 * `provider` is sent only when it changed (`''` clears it), so a stored value
 * this machine does not know — shown, never dropped — is kept verbatim rather
 * than refused by the contract's catalog enum. A site is sent only when it
 * differs from what is stored: the registry merges sites one by one
 * (`mergeDecisionsConfig`, extensions/personalities), so an unchanged site is
 * kept, and a site left at `off` on a personality that never declared it
 * writes no `decisions.sites.<site>: off` line. With None, no site is sent:
 * the controls are disabled and a stored site is inert without a provider
 * (PD10) — kept, so choosing the model again restores it.
 */
export function decisionsUpdateInput(
  value: DecisionFieldValue,
  stored: StoredDecisions,
): DecisionsPatch {
  const patch: DecisionsPatch = {};
  if (value.provider !== (stored?.provider ?? '')) {
    if (value.provider === '') patch.provider = '';
    else {
      const id = DecisionProviderIdSchema.safeParse(value.provider);
      if (id.success) patch.provider = id.data;
    }
  }
  if (value.provider === '') return patch;
  const sites: Partial<Record<DecisionSiteId, DecisionSiteMode>> = {};
  for (const { site } of DECISION_SITE_ROWS) {
    if (value.sites[site] !== (stored?.sites?.[site] ?? 'off')) sites[site] = value.sites[site];
  }
  if (Object.keys(sites).length > 0) patch.sites = sites;
  return patch;
}

/** The `decisions` input of `personalities.update`. */
export interface DecisionsPatch {
  provider?: z.infer<typeof DecisionProviderIdSchema> | '';
  sites?: Partial<Record<DecisionSiteId, DecisionSiteMode>>;
}

/**
 * The select's options: None, then every ADDED decision model
 * (`decisions.list` `providers`), then a stored value the list lacks — shown,
 * not dropped, so opening and saving the form never clears a reference.
 */
export function decisionProviderOptions(
  providers: readonly Pick<DecisionProviderView, 'id' | 'label' | 'vendor'>[],
  storedProvider: string | undefined,
): Array<{ value: string; label: string }> {
  const options = [
    { value: '', label: 'None' },
    ...providers.map((p) => ({ value: p.id, label: `${p.label} · ${p.vendor}` })),
  ];
  if (storedProvider && !providers.some((p) => p.id === storedProvider)) {
    options.push({
      value: storedProvider,
      label: `${storedProvider} (not configured on this machine)`,
    });
  }
  return options;
}

/** The saved resolution, when the field still shows the saved provider. */
function savedResolution(value: DecisionFieldValue, stored: StoredDecisions) {
  if (value.provider === '' || value.provider !== (stored?.provider ?? '')) return undefined;
  return stored?.resolved;
}

/**
 * The note under the select, when the saved decision model cannot run here:
 * the operator has not configured it (every site runs `off`), or it is
 * configured with no key stored (every site takes today's path).
 */
export function decisionProviderNote(
  value: DecisionFieldValue,
  stored: StoredDecisions,
): string | null {
  const resolved = savedResolution(value, stored);
  if (!resolved) return null;
  if (!resolved.configured) {
    return 'Not configured on this machine — every site runs off. Add it in Settings → Models.';
  }
  if (resolved.apiKeyPresent === false) {
    return 'No key stored — every site takes today’s path until one is added in Settings → Models.';
  }
  return null;
}

/**
 * The note under one site row, or null — only while the row shows its saved
 * mode:
 *
 * - R6: `on` runs as `shadow` while a threshold is missing.
 * - The approver is inert: the personality's approval mode is not `smart`, so
 *   it is never consulted. Hidden once this form's (unsaved) approval mode is
 *   Smart — the next save resolves it again.
 */
export function decisionSiteNote(input: {
  site: DecisionSiteId;
  value: DecisionFieldValue;
  stored: StoredDecisions;
  approvalMode: 'manual' | 'smart' | 'off' | undefined;
}): string | null {
  const { site, value, stored } = input;
  const resolved = savedResolution(value, stored);
  if (!resolved || value.sites[site] !== (stored?.sites?.[site] ?? 'off')) return null;
  const row = resolved.sites.find((r) => r.site === site);
  if (!row) return null;
  const notes: string[] = [];
  if (row.reason === 'threshold-missing') {
    notes.push(`on requested, running shadow: ${row.missingThresholds.join(', ')} missing`);
  }
  if (row.inertApprovalMode !== undefined && input.approvalMode !== 'smart') {
    notes.push(
      `Inert: approval mode is ${row.inertApprovalMode}; the approver runs only when Approval mode is Smart.`,
    );
  }
  return notes.length > 0 ? notes.join(' · ') : null;
}
