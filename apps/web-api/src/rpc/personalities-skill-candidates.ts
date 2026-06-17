import { os } from './context';

// Pending skill-candidate review queue. The nightly skill-evolver (manual
// mode) drafts candidates into `<dataDir>/skills/.pending/<id>/`; these
// procedures list / approve (promote) / reject (delete) them. Split out of
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
