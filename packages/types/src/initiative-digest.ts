/**
 * The owner digest and options brief: the view model the runner composes and the channel adapters
 * render, plus the compact button action id. Zero dependencies (contracts layer).
 *
 * A button carries `init:<verb>:<target>` and nothing else. `<target>` is a ledger id (an
 * exploration or an initiative), never text a model wrote, and the digest goes only to the owner
 * channel in the config; a tap is bound to a decision by the wiring, not by anything in a payload.
 */
import type { InitiativeVerdict } from './initiative';

export const INITIATIVE_ACTION_PREFIX = 'init';

/** `edit` hands the scope change to chat; `copy_md` replies with the brief as Markdown. Neither records a decision. */
export type InitiativeActionVerb = InitiativeVerdict | 'edit' | 'copy_md';

const VERBS: readonly InitiativeActionVerb[] = [
  'approve',
  'reject',
  'snooze',
  'adopt',
  'dig_deeper',
  'park',
  'keep',
  'make_mine',
  'stop',
  'edit',
  'copy_md',
];

/** Ledger ids only (`EXP-0001`, an initiative slug). No colon, so a fixed split is exact. */
const TARGET = /^[A-Za-z0-9._-]{1,64}$/;

/** Telegram `callback_data` limit, in UTF-8 bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64;

export function initiativeActionId(verb: InitiativeActionVerb, target: string): string {
  return `${INITIATIVE_ACTION_PREFIX}:${verb}:${target}`;
}

/** Null for anything that is not a well-formed action id; a malformed payload is dropped, never thrown. */
export function parseInitiativeAction(
  data: string,
): { verb: InitiativeActionVerb; target: string } | null {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== INITIATIVE_ACTION_PREFIX) return null;
  const verb = VERBS.find((v) => v === parts[1]);
  const target = parts[2];
  if (verb === undefined || target === undefined || !TARGET.test(target)) return null;
  return { verb, target };
}

export interface DigestBrief {
  explorationId: string;
  initiativeId: string;
  question: string;
  found: Array<{ id: string; claim: string }>;
  stillUnknown: string[];
  options: string[];
  effort: string;
  risk: string;
  recommendation: string;
  recommendedOption: string | null;
  partial: boolean;
  /** `usd_per_exploration` of the initiative: what "Dig deeper" would grant. Null when unknown. */
  digDeeperUsd: number | null;
}

export interface InitiativeDigest {
  personalityId: string;
  /** ISO time of composition. */
  generatedAt: string;
  /** ISO start of the period the "on its own" section covers. */
  since: string;
  /** What it did without asking: windows run and spend since `since`, per exploration. */
  ownWork: {
    windows: number;
    spentUsd: number;
    explorations: Array<{
      id: string;
      question: string;
      /** Started under the autonomy rule: no owner approval row exists for it. */
      auto: boolean;
      windows: number;
      spentUsd: number;
    }>;
  };
  /** Proposals awaiting Gate 1. */
  needsYes: Array<{ explorationId: string; question: string; estimateUsd: number | null }>;
  /** Agent-started initiatives awaiting Keep / Make it mine / Stop. */
  agentInitiatives: Array<{ id: string; parentId: string | null }>;
  briefs: DigestBrief[];
  /** Questions a run asked through clarify and nobody has answered. */
  questions: Array<{ id: string; initiativeId: string; text: string }>;
  /** `new_initiative` drafts the agent proposed while self-start is off. */
  suggestions: Array<{ draftId: string; parentId: string; why: string }>;
}

/** True when there is nothing to say, so no digest is sent. */
export function digestIsEmpty(d: InitiativeDigest): boolean {
  return (
    d.ownWork.windows === 0 &&
    d.needsYes.length === 0 &&
    d.agentInitiatives.length === 0 &&
    d.briefs.length === 0 &&
    d.questions.length === 0 &&
    d.suggestions.length === 0
  );
}
