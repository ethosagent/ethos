import type { EvolveConfig } from '@ethosagent/skill-evolver';
import type { EvolverRun, PendingSkill } from '@ethosagent/web-contracts';
import { toPendingSkillSummary } from '@ethosagent/wiring';
import type { EvolverRepository } from '../repositories/evolver.repository';
import { type LearningService, learningRefusalError } from './learning.service';

// Evolver-tab service. Composes:
//
//   • EvolverRepository (web-only) — EvolveConfig file + run-history log
//   • LearningService — the learning inbox, which replaced the skills approval queue
//
// The actual SkillEvolver.evolve() is invoked by the CLI today
// (`ethos skills evolve`); this service only owns the data the web tab
// needs to surface.
//
// `pendingList / pendingApprove / pendingReject` are legacy adapters (plan
// `trust-before-reach.md` Part 4, L-T8). They used to drive
// `SkillsLibrary.approvePending` over `skills/.pending/`, a queue nothing
// writes any more. They now list WAITING SKILL CANDIDATES (ids are candidate
// ids) and decide through `LearningService`, so they are subject to the same
// override rule as `learning.approve`: `pendingApprove` has no field for a
// reason, so a candidate whose replay did not pass is refused with
// `INVALID_INPUT` naming the paths that can carry one — `ethos learning approve
// <id> --override`, and the web Learning page, which approves through
// `learning.approve` and prompts for the reason.

export interface EvolverServiceOptions {
  evolver: EvolverRepository;
  learning: LearningService;
}

export class EvolverService {
  constructor(private readonly opts: EvolverServiceOptions) {}

  async getConfig(): Promise<{ config: EvolveConfig }> {
    return { config: await this.opts.evolver.getConfig() };
  }

  async updateConfig(config: EvolveConfig): Promise<{ config: EvolveConfig }> {
    return { config: await this.opts.evolver.setConfig(config) };
  }

  async listPending(): Promise<{ pending: PendingSkill[] }> {
    const pending = await this.opts.learning.pendingSkills();
    return { pending: pending.map(toPendingSkillSummary) };
  }

  async approvePending(id: string): Promise<void> {
    const result = await this.opts.learning.approve({ candidateId: id, decidedBy: 'web:evolver' });
    if (!result.ok) {
      throw learningRefusalError(
        result,
        result.code === 'override_required'
          ? 'Approve it with a reason on the Learning page, or run `ethos learning approve <id> --override "<reason>"`.'
          : 'Reopen the Learning page to see where this candidate stands; `ethos learning show <id>` prints its timeline.',
      );
    }
  }

  async rejectPending(id: string): Promise<void> {
    const result = await this.opts.learning.reject({ candidateId: id, decidedBy: 'web:evolver' });
    if (!result.ok) {
      throw learningRefusalError(
        result,
        'Reopen the Learning page to see where this candidate stands.',
      );
    }
  }

  async listHistory(limit: number = 20): Promise<{ runs: EvolverRun[] }> {
    return { runs: await this.opts.evolver.listHistory(limit) };
  }
}
