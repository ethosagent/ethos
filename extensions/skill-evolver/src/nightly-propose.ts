// Phase 3d — nightly skill proposal. The governed nightly pass calls
// proposeSkillFromEvidence() to DRAFT one skill candidate from the night's
// evidence digest, then gate it on the personality's approval mode:
//
//   manual (evolution_approval_mode unset or 'user'): write the candidate to
//     the per-personality pending queue (<dataDir>/skills/.pending/<id>/) only.
//     A human promotes it later via `ethos evolve apply`.
//   auto (evolution_approval_mode === 'auto'): validate the candidate through
//     the injected `validate` seam (the ImprovementFork proposal test harness in
//     production; a stub in tests). On PASS, promote it to <dataDir>/skills/;
//     on FAIL, leave it in pending.
//
// Drafting reuses the existing renderNewSkillPrompt / parseNewSkillResponse
// machinery — the same "synthesize a new skill from work" path the eval-driven
// evolver uses — fed a single synthetic task built from the evidence digest.
//
// Idempotency is the orchestrator's job (it records the `skills` step in the
// nightly checkpoint and skips it on re-run for the same window). This function
// additionally refuses to draft a second candidate for a window that already
// has one queued, so a forced re-run never double-writes.

import { join } from 'node:path';
import type { LLMProvider, Message, Storage } from '@ethosagent/types';
import { parseNewSkillResponse, renderNewSkillPrompt } from './prompts';
import type { TaskSummary } from './types';

export type ApprovalMode = 'auto' | 'user';

export type ProposalDecision = 'queued' | 'promoted' | 'rejected' | 'none';

export interface NightlySkillProposalResult {
  decision: ProposalDecision;
  /** Candidate filename (without the pending/live directory). Null when none was drafted. */
  fileName: string | null;
  /** Short human-readable reason for the decision. */
  reason: string;
}

export interface ProposeSkillInput {
  /** Personality id — scopes the per-personality pending directory. */
  personalityId: string;
  /** Approval gate. Absent/'user' = manual (queue only); 'auto' = validate + maybe promote. */
  approvalMode: ApprovalMode | undefined;
  /**
   * Promotion gate override. `'auto'` promotes after validation; `'review'`
   * queues for human approval. When unset, falls back to `approvalMode`.
   */
  promotion?: 'review' | 'auto';
  /**
   * Where a promoted skill is written. `'shared'` (default) = <dataDir>/skills/;
   * `'personality'` = <dataDir>/personalities/<id>/skills/.
   */
  scope?: 'personality' | 'shared';
  /** Compact prose digest of the night's interactions (NightlyEvidence.evidenceDigest). */
  evidenceDigest: string;
  /** Stable window marker — used to namespace the candidate so re-runs are idempotent. */
  windowEnd: string;
  /** ~/.ethos root; pending = <dataDir>/skills/.pending/<id>/, live = <dataDir>/skills/. */
  dataDir: string;
  storage: Storage;
  llm: LLMProvider;
  /**
   * Auto-mode validation seam. Receives the drafted candidate markdown and
   * returns whether it passes. In production this runs the ImprovementFork
   * proposal test harness; tests inject a stub. Only called in 'auto' mode.
   */
  validate?: (candidate: { fileName: string; content: string }) => Promise<boolean>;
}

async function callLLM(llm: LLMProvider, prompt: string): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  let text = '';
  for await (const chunk of llm.complete(messages, [], { maxTokens: 2048, temperature: 0.2 })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }
  return text;
}

// A window-stable filename so a forced re-run of the same nightly window can
// detect (and skip) an already-queued candidate. The window end is sanitised
// into a filename-safe token.
function candidateFileName(windowEnd: string): string {
  const token = windowEnd.replace(/[^0-9a-zA-Z]/g, '').slice(0, 16) || 'window';
  return `nightly-${token}.md`;
}

/**
 * Draft and gate ONE skill candidate from nightly evidence. Returns the
 * decision and the candidate filename (null if nothing was drafted).
 *
 * Errors are NOT swallowed here — the caller (the nightly `createSkills` dep)
 * surfaces them as a failed step, mirroring the judge/expression steps.
 */
export async function proposeSkillFromEvidence(
  input: ProposeSkillInput,
): Promise<NightlySkillProposalResult> {
  const fileName = candidateFileName(input.windowEnd);
  const pendingDir = join(input.dataDir, 'skills', '.pending', input.personalityId);
  const liveDir =
    input.scope === 'personality'
      ? join(input.dataDir, 'personalities', input.personalityId, 'skills')
      : join(input.dataDir, 'skills');
  const pendingPath = join(pendingDir, fileName);
  const livePath = join(liveDir, fileName);

  // Idempotency guard: a candidate for this window already exists (pending or
  // promoted). Do not draft or promote again.
  if ((await input.storage.read(pendingPath)) !== null) {
    return { decision: 'queued', fileName, reason: 'candidate already queued for this window' };
  }
  if ((await input.storage.read(livePath)) !== null) {
    return { decision: 'promoted', fileName, reason: 'candidate already promoted for this window' };
  }

  // Draft via the existing new-skill synthesis prompt, feeding the evidence
  // digest as a single synthetic high-scoring task.
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
    return { decision: 'none', fileName: null, reason: `no candidate (${parsed.reason})` };
  }

  const body = `${parsed.content}\n`;

  // Promotion gate. The explicit `promotion` knob wins when set; otherwise
  // fall back to the legacy `approvalMode`-based gate. 'review' === manual.
  const auto = input.promotion ? input.promotion === 'auto' : input.approvalMode === 'auto';

  // Manual gate (review / unset 'user'): queue only, never promote.
  if (!auto) {
    await input.storage.mkdir(pendingDir);
    await input.storage.write(pendingPath, body);
    return { decision: 'queued', fileName, reason: 'manual approval — queued for review' };
  }

  // Auto gate: validate, then promote on PASS / queue on FAIL.
  const passed = input.validate ? await input.validate({ fileName, content: body }) : true;
  if (!passed) {
    await input.storage.mkdir(pendingDir);
    await input.storage.write(pendingPath, body);
    return { decision: 'rejected', fileName, reason: 'auto validation failed — left in pending' };
  }

  await input.storage.mkdir(liveDir);
  await input.storage.write(livePath, body);
  return { decision: 'promoted', fileName, reason: 'auto validation passed — promoted' };
}
