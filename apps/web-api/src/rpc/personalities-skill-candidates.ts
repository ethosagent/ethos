import { os } from './context';

// Pending skill-candidate review queue — a legacy adapter over the learning
// inbox (L-T8). These procedures list this personality's waiting skill
// candidates and approve / reject them through `LearningService`; see
// `PersonalitiesService.skillCandidatesList` for what changed. Split out of
// `personalities.ts` to keep each handler file thin. Spread into
// `personalitiesRouter`.

export const personalitiesSkillCandidatesRouter = {
  skillCandidatesList: os.personalities.skillCandidatesList.handler(({ input, context }) =>
    context.personalities.skillCandidatesList(input.personalityId),
  ),
  skillCandidateApprove: os.personalities.skillCandidateApprove.handler(({ input, context }) =>
    context.personalities.skillCandidateApprove(input.personalityId, input.fileName),
  ),
  skillCandidateReject: os.personalities.skillCandidateReject.handler(
    async ({ input, context }) => {
      await context.personalities.skillCandidateReject(input.personalityId, input.fileName);
      return { ok: true as const };
    },
  ),
};
