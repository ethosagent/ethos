/**
 * Initiative engine contracts: lifecycle state machines, ledger rows and the
 * store/config ports. Zero dependencies (contracts layer). The ledger port is
 * the narrow surface runs and ledger tools may call; the full store adds the
 * approval-surface writers that tools must never hold.
 */

export type InitiativeOrigin = 'human' | 'agent';
export type InitiativeState = 'active' | 'self_started' | 'paused' | 'review' | 'ended' | 'stopped';
export type ExplorationState =
  | 'idea'
  | 'proposed'
  | 'exploring'
  | 'rejected'
  | 'stalled'
  | 'briefed'
  | 'adopted'
  | 'parked';
export type AutonomyMode = 'ask' | 'free' | 'free_under';
export type GateId = 'gate1_explore' | 'gate2_adopt' | 'self_start' | 'config_change';
export type InitiativeVerdict =
  | 'approve'
  | 'reject'
  | 'snooze'
  | 'adopt'
  | 'dig_deeper'
  | 'park'
  | 'keep'
  | 'make_mine'
  | 'stop';
export type WindowKind = 'survey' | 'scan' | 'window' | 'brief';
export type DraftStatus = 'pending' | 'materialised' | 'refused';

/** Allowed moves. Spec "Initiative lifecycle". */
export const INITIATIVE_TRANSITIONS: Readonly<
  Record<'start' | InitiativeState, readonly InitiativeState[]>
> = {
  start: ['active', 'self_started'],
  self_started: ['active', 'stopped', 'paused'],
  active: ['paused', 'review'],
  paused: ['active'],
  review: ['active', 'ended'],
  ended: [],
  stopped: [],
};

/** Spec "Exploration lifecycle". */
export const EXPLORATION_TRANSITIONS: Readonly<
  Record<'start' | ExplorationState, readonly ExplorationState[]>
> = {
  start: ['idea'],
  idea: ['proposed'],
  proposed: ['exploring', 'rejected'],
  exploring: ['briefed', 'stalled'],
  stalled: ['briefed'],
  briefed: ['exploring', 'adopted', 'parked'],
  rejected: [],
  adopted: [],
  parked: [],
};

export function canTransition<S extends string>(
  table: Readonly<Record<string, readonly S[]>>,
  from: S | 'start',
  to: S,
): boolean {
  return table[from]?.includes(to) ?? false;
}

export interface InitiativeRow {
  id: string;
  personalityId: string;
  origin: InitiativeOrigin;
  parentId: string | null;
  state: InitiativeState;
  configPath: string;
  configHash: string;
  version: number;
}

export interface IdeaRow {
  id: string;
  initiativeId: string;
  origin: 'human' | 'agent';
  text: string;
  sourceRef: string | null;
  createdAt: string;
}

export interface ExplorationRow {
  id: string;
  initiativeId: string;
  ideaId: string | null;
  question: string;
  state: ExplorationState;
  budgetUsd: number;
  spentUsd: number;
  deadline: string;
  estimateUsd: number | null;
}

export interface FindingRow {
  id: string;
  explorationId: string;
  claim: string;
  sourceRef: string;
  confidence: number;
  createdAt: string;
}

export interface BriefRow {
  id: string;
  explorationId: string;
  version: number;
  bodyMd: string;
  recommendedOption: string | null;
  partial: boolean;
}

export interface DecisionRow {
  id: string;
  target: string;
  gate: GateId;
  verdict: InitiativeVerdict;
  reason: string | null;
  option: string | null;
  decidedBy: string;
  at: string;
}

export interface WindowRow {
  id: string;
  initiativeId: string;
  explorationId: string | null;
  kind: WindowKind;
  started: string;
  ended: string | null;
  spentUsd: number;
  toolsUsed: string[];
  reads: string[];
  checkpoint: string | null;
  endReason: string | null;
}

/** A question the run asked via clarify; shown in the digest until answered. */
export interface QuestionRow {
  id: string;
  initiativeId: string;
  explorationId: string | null;
  text: string;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface DraftRow {
  id: string;
  parentId: string;
  draftYaml: string;
  why: string;
  status: DraftStatus;
  refusal: string | null;
  createdAt: string;
}

/** What runs and ledger tools may call. No decision writer, no config writer. */
export interface InitiativeLedgerPort {
  addIdea(i: Omit<IdeaRow, 'id' | 'createdAt'>): IdeaRow;
  propose(p: {
    initiativeId: string;
    ideaId: string | null;
    question: string;
    estimateUsd: number;
    days: number;
  }): ExplorationRow;
  proposeInitiativeDraft(d: { parentId: string; draftYaml: string; why: string }): {
    draftId: string;
  };
  addFinding(f: Omit<FindingRow, 'id' | 'createdAt'>): FindingRow;
  submitBrief(b: Omit<BriefRow, 'id' | 'version'>): BriefRow;
  /** Run-local clarify: records a question for the digest; returns its id. */
  addQuestion(q: { initiativeId: string; explorationId: string | null; text: string }): string;
  ideas(initiativeId: string): IdeaRow[];
  budget(
    initiativeId: string,
    day: string,
  ): { spentUsd: number; capUsd: number; explorationsOpen: number };
  /** The initiative id that owns an exploration or idea; null when the id does not exist. Ledger tools refuse any id owned by another initiative. */
  ownerOf(kind: 'exploration' | 'idea', id: string): string | null;
}

/** Full store. Approval surfaces and the runner hold it; tools never do. */
export interface InitiativeStore extends InitiativeLedgerPort {
  /** Throws on an illegal move (see INITIATIVE_TRANSITIONS). */
  transitionInitiative(id: string, to: InitiativeState, why: string): void;
  /** Throws on an illegal move (see EXPLORATION_TRANSITIONS). */
  transitionExploration(id: string, to: ExplorationState, why: string): void;
  /** Approval surfaces only. One transaction: decision row + the transition it implies. */
  recordDecision(d: Omit<DecisionRow, 'id' | 'at'>): DecisionRow;
  /** Called by InitiativeConfigService only. */
  upsertInitiative(row: InitiativeRow): void;
  appendConfigVersion(v: {
    initiativeId: string;
    version: number;
    hash: string;
    diff: string;
    sessionId: string | null;
    confirmedBy: string;
  }): void;
  /**
   * Runner only. A "dig deeper" reopens an exploration with a new budget: `budget_usd` becomes
   * what it has spent plus `addBudgetUsd`, and the deadline moves. Not a decision.
   */
  extendExploration(id: string, e: { addBudgetUsd: number; deadline: string }): ExplorationRow;
  /** Drafts in one status, oldest first. The runner's materialiser reads `pending`. */
  drafts(status: DraftStatus): DraftRow[];
  /** Runner only. Settles a pending draft once; a draft already settled is left as it is. */
  settleDraft(id: string, status: 'materialised' | 'refused', refusal: string | null): void;
  /**
   * When an initiative started, when its owner last reacted (a decision on it or on one of its
   * explorations; null = never) and why it was stopped. The auto-pause clock reads this.
   */
  reactionClock(id: string): {
    createdAt: string;
    lastReactionAt: string | null;
    stopReason: string | null;
  } | null;
  openWindow(w: { initiativeId: string; explorationId: string | null; kind: WindowKind }): string;
  closeWindow(
    id: string,
    r: {
      spentUsd: number;
      toolsUsed: string[];
      reads: string[];
      checkpoint: string | null;
      endReason: string;
    },
  ): void;
  getInitiative(id: string): InitiativeRow | null;
  getExploration(id: string): ExplorationRow | null;
  explorations(initiativeId: string, states?: ExplorationState[]): ExplorationRow[];
  list(filter: { personalityId: string; states?: InitiativeState[] }): InitiativeRow[];
  get(id: string): {
    initiative: InitiativeRow;
    explorations: ExplorationRow[];
    briefs: BriefRow[];
    findings: FindingRow[];
  } | null;
  /** LIKE over findings.claim, briefs.body_md, explorations.question. */
  search(
    personalityId: string,
    q: string,
    limit: number,
  ): Array<{ kind: 'finding' | 'brief' | 'exploration'; id: string; snippet: string }>;
  /** One line per active initiative / open exploration. */
  indexLines(personalityId: string, max: number): string[];
}

/** What recall tools (initiative_list/search/get) call: the read side of the store, nothing else. */
export type InitiativeRecallPort = Pick<InitiativeStore, 'list' | 'search' | 'get'>;

/** What chat tools call. Implemented by InitiativeConfigService (3.6). */
export interface InitiativeConfigPort {
  save(input: {
    personalityId: string;
    op: 'create' | 'update' | 'pause' | 'resume' | 'end';
    draft: unknown;
    sessionId: string;
    confirmedBy: 'owner_chat' | 'owner_ui' | 'runner';
  }): Promise<
    | {
        ok: true;
        id: string;
        version: number;
        clamps: string[];
        guidance: GuidanceMapping[];
        /** ISO time of the next survey window, when the service can compute it. */
        nextSurveyAt?: string;
      }
    | { ok: false; error: string }
  >;
}

export interface GuidanceMapping {
  text: string;
  status: 'mapped' | 'unreachable' | 'refused';
  mapsTo: string[];
  reason?: string;
}
