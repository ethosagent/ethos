// Phase 3d — nightly skill proposal (path 2 in plan `trust-before-reach.md`
// Part 4). The governed nightly pass calls proposeSkillFromEvidence() to DRAFT
// one skill candidate from the night's evidence digest and submit it to the
// learning inbox.
//
// Nothing here promotes. It used to: an `auto` personality's draft went live on
// one LLM PASS/FAIL reply, and an omitted validator defaulted to PASS. Whether a
// candidate goes live is now decided after a replay by `replayAndResolve`
// (`extensions/learning-inbox/src/auto-promotion.ts`), which reads the auto
// knobs once (L-D3) and never takes an LLM opinion as the verdict (L-D1).
//
// Drafting reuses the existing renderNewSkillPrompt / parseNewSkillResponse
// machinery — the same "synthesize a new skill from work" path the eval-driven
// evolver uses — fed a single synthetic task built from the evidence digest.
//
// Idempotency: the orchestrator checkpoints the `skills` step per window, and
// the candidate id is derived from the personality and the window
// (`nightlySkillCandidateId`), so a forced re-run finds the candidate already
// submitted and drafts nothing — no second LLM call.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { LLMProvider, Message } from '@ethosagent/types';
import type { LearningSubmitPort } from './learning-port';
import { parseNewSkillResponse, renderNewSkillPrompt } from './prompts';
import { liveSkillDir } from './skill-dir';
import type { TaskSummary } from './types';

export type ProposalDecision = 'submitted' | 'exists' | 'none';

export interface NightlySkillProposalResult {
  decision: ProposalDecision;
  /** The inbox candidate id. Null when nothing was drafted. */
  candidateId: string | null;
  /** Candidate filename at its destination. Null when nothing was drafted. */
  fileName: string | null;
  /** Short human-readable reason for the decision. */
  reason: string;
}

export interface ProposeSkillInput {
  personalityId: string;
  /**
   * `skill_evolution.scope`. Decides the destination: `'personality'` =
   * `<dataDir>/personalities/<id>/skills/`, otherwise `<dataDir>/skills/`.
   */
  scope?: 'personality' | 'shared';
  /** Compact prose digest of the night's interactions (NightlyEvidence.evidenceDigest). */
  evidenceDigest: string;
  /** Stable window marker — namespaces the candidate so re-runs are idempotent. */
  windowEnd: string;
  /** ~/.ethos root. */
  dataDir: string;
  llm: LLMProvider;
  learning: LearningSubmitPort;
  /** The evidence sessions the digest was built from. */
  evidenceSessionIds?: string[];
  /** Frozen cases from the evidence sessions, for the replay to improve on. */
  targetCaseIds?: readonly string[];
}

async function callLLM(llm: LLMProvider, prompt: string): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  let text = '';
  for await (const chunk of llm.complete(messages, [], { maxTokens: 2048, temperature: 0.2 })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }
  return text;
}

// A window-stable filename so a forced re-run of the same nightly window lands
// on the same destination. The window end is sanitised into a filename token.
function candidateFileName(windowEnd: string): string {
  const token = windowEnd.replace(/[^0-9a-zA-Z]/g, '').slice(0, 16) || 'window';
  return `nightly-${token}.md`;
}

/** One candidate per personality per window. */
export function nightlySkillCandidateId(personalityId: string, windowEnd: string): string {
  const digest = createHash('sha256').update(`${personalityId}@${windowEnd}`, 'utf8').digest('hex');
  return `n-${digest.slice(0, 16)}`;
}

/**
 * Draft ONE skill candidate from nightly evidence and submit it. Errors are NOT
 * swallowed here — the caller (the nightly `createSkills` dep) surfaces them as
 * a failed step, mirroring the judge/expression steps.
 */
export async function proposeSkillFromEvidence(
  input: ProposeSkillInput,
): Promise<NightlySkillProposalResult> {
  const fileName = candidateFileName(input.windowEnd);
  const id = nightlySkillCandidateId(input.personalityId, input.windowEnd);

  if (await input.learning.has(id)) {
    return {
      decision: 'exists',
      candidateId: id,
      fileName,
      reason: 'candidate already submitted for this window',
    };
  }

  const task: TaskSummary = {
    taskId: `nightly:${input.windowEnd}`,
    prompt: 'Recent interactions for this personality',
    response: input.evidenceDigest,
    score: 1,
    skillFilesUsed: [],
  };
  const raw = await callLLM(input.llm, renderNewSkillPrompt({ tasks: [task] }));
  const parsed = parseNewSkillResponse(raw);
  if (parsed.kind === 'skip') {
    return {
      decision: 'none',
      candidateId: null,
      fileName: null,
      reason: `no candidate (${parsed.reason})`,
    };
  }

  const destination = join(liveSkillDir(input.dataDir, input.personalityId, input.scope), fileName);
  const candidate = await input.learning.submit({
    id,
    kind: 'skill',
    op: 'create',
    personalityId: input.personalityId,
    origin: 'nightly',
    destination,
    content: `${parsed.content}\n`,
    evidence: {
      sessionIds: input.evidenceSessionIds ?? [],
      digest: input.evidenceDigest,
      ref: `nightly:${input.windowEnd}`,
    },
    targetCaseIds: input.targetCaseIds ?? [],
  });
  return {
    decision: 'submitted',
    candidateId: candidate.id,
    fileName,
    reason: 'submitted to the learning inbox; waits for replay',
  };
}
