// The slice of `@ethosagent/learning-inbox` this package submits through
// (plan `trust-before-reach.md` Part 4, L-T6).
//
// Every skill writer here — the live fork's and chat's `skill_propose`, the
// nightly `proposeSkillFromEvidence`, the eval-driven `SkillEvolver` — used to
// write a pending file into one of three queues, or straight into the live
// dir. They now hand a candidate to the one inbox instead, and nothing in this
// package promotes.
//
// Declared structurally rather than imported: `submitCandidate` and
// `readCandidate` in `extensions/learning-inbox/src/store.ts` satisfy it, and
// the composition root (`packages/wiring/src/learning-pipeline.ts`
// `learningSubmitPort`) binds them to a Storage and a data dir. That keeps this
// package's dependency list unchanged and leaves the inbox free to depend on
// nothing above `@ethosagent/types`.

export type SkillCandidateOrigin = 'fork' | 'nightly' | 'chat' | 'eval';

/** A structural subset of the inbox's `SubmitCandidateInput`. */
export interface SkillCandidateSubmission {
  kind: 'skill';
  /** `create` writes a new file; `rewrite` replaces the content's `target_file`. */
  op: 'create' | 'rewrite';
  personalityId: string;
  origin: SkillCandidateOrigin;
  /**
   * The live path, resolved at submit time with `liveSkillDir` and the
   * personality's `skill_evolution.scope` — plus the new filename for a
   * create, or `target_file` for a rewrite.
   */
  destination: string;
  content: string;
  evidence?: {
    sessionIds?: string[];
    taskIds?: string[];
    digest?: string | null;
    ref?: string | null;
  };
  /** Frozen cases the replay must improve on. */
  targetCaseIds?: readonly string[];
  /** A stable id makes a re-submit a no-op (the inbox returns the stored candidate). */
  id?: string;
}

export interface LearningSubmitPort {
  submit(input: SkillCandidateSubmission): Promise<{ id: string }>;
  /** Whether a candidate with this id is already in the inbox, in any status. */
  has(candidateId: string): Promise<boolean>;
}
