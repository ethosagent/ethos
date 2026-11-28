import type {
  BriefRow,
  DecisionRow,
  ExplorationRow,
  ExplorationState,
  FindingRow,
  GateId,
  IdeaRow,
  InitiativeOrigin,
  InitiativeRow,
  InitiativeState,
  InitiativeVerdict,
  QuestionRow,
  WindowKind,
  WindowRow,
} from '@ethosagent/types';

export interface InitiativeDbRow {
  id: string;
  personality_id: string;
  origin: string;
  parent_id: string | null;
  state: string;
  config_path: string;
  config_hash: string;
  version: number;
}

export interface IdeaDbRow {
  id: string;
  initiative_id: string;
  origin: string;
  text: string;
  source_ref: string | null;
  created_at: string;
}

export interface ExplorationDbRow {
  id: string;
  initiative_id: string;
  idea_id: string | null;
  question: string;
  state: string;
  budget_usd: number;
  spent_usd: number;
  estimate_usd: number | null;
  deadline: string;
}

export interface WindowDbRow {
  id: string;
  initiative_id: string;
  exploration_id: string | null;
  kind: string;
  started: string;
  ended: string | null;
  spent_usd: number;
  tools_used: string;
  reads: string;
  checkpoint: string | null;
  end_reason: string | null;
}

export interface QuestionDbRow {
  id: string;
  initiative_id: string;
  exploration_id: string | null;
  text: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

export const INITIATIVE_COLS =
  'id, personality_id, origin, parent_id, state, config_path, config_hash, version';
export const EXPLORATION_COLS =
  'id, initiative_id, idea_id, question, state, budget_usd, spent_usd, estimate_usd, deadline';

export function toInitiative(r: InitiativeDbRow): InitiativeRow {
  return {
    id: r.id,
    personalityId: r.personality_id,
    origin: r.origin as InitiativeOrigin,
    parentId: r.parent_id,
    state: r.state as InitiativeState,
    configPath: r.config_path,
    configHash: r.config_hash,
    version: r.version,
  };
}

export function toIdea(r: IdeaDbRow): IdeaRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    origin: r.origin === 'human' ? 'human' : 'agent',
    text: r.text,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
  };
}

export function toExploration(r: ExplorationDbRow): ExplorationRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    ideaId: r.idea_id,
    question: r.question,
    state: r.state as ExplorationState,
    budgetUsd: r.budget_usd,
    spentUsd: r.spent_usd,
    deadline: r.deadline,
    estimateUsd: r.estimate_usd,
  };
}

/** `?, ?, ?` placeholders for an SQL `IN (...)` over `values`. */
export function inClause(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export interface BriefDbRow {
  id: string;
  exploration_id: string;
  version: number;
  body_md: string;
  recommended_option: string | null;
  partial: number;
}

export function toBrief(r: BriefDbRow): BriefRow {
  return {
    id: r.id,
    explorationId: r.exploration_id,
    version: r.version,
    bodyMd: r.body_md,
    recommendedOption: r.recommended_option,
    partial: r.partial === 1,
  };
}

export interface FindingDbRow {
  id: string;
  exploration_id: string;
  claim: string;
  source_ref: string;
  confidence: number;
  created_at: string;
}

export function toFinding(r: FindingDbRow): FindingRow {
  return {
    id: r.id,
    explorationId: r.exploration_id,
    claim: r.claim,
    sourceRef: r.source_ref,
    confidence: r.confidence,
    createdAt: r.created_at,
  };
}

export interface DecisionDbRow {
  id: string;
  target: string;
  gate: string;
  verdict: string;
  reason: string | null;
  option: string | null;
  decided_by: string;
  at: string;
}

export function toDecision(r: DecisionDbRow): DecisionRow {
  return {
    id: r.id,
    target: r.target,
    gate: r.gate as GateId,
    verdict: r.verdict as InitiativeVerdict,
    reason: r.reason,
    option: r.option,
    decidedBy: r.decided_by,
    at: r.at,
  };
}

/** A JSON text column that must hold a string array; anything else reads as empty. */
export function parseStrings(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

export function toWindow(r: WindowDbRow): WindowRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    explorationId: r.exploration_id,
    kind: r.kind as WindowKind,
    started: r.started,
    ended: r.ended,
    spentUsd: r.spent_usd,
    toolsUsed: parseStrings(r.tools_used),
    reads: parseStrings(r.reads),
    checkpoint: r.checkpoint,
    endReason: r.end_reason,
  };
}

export function toQuestion(r: QuestionDbRow): QuestionRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    explorationId: r.exploration_id,
    text: r.text,
    answer: r.answer,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** ~80 chars of `text` around the first case-insensitive match of `needle`. */
export function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, flat.toLowerCase().indexOf(needle.toLowerCase()));
  const start = Math.max(0, at - 30);
  const end = Math.min(flat.length, at + needle.length + 50);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
