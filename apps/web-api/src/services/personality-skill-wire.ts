import type { PersonalitySkillRecord, SkillsLibrary } from '@ethosagent/skills';
import type { PersonalitySkill } from '@ethosagent/web-contracts';

/**
 * A personality's own skill on the wire, with its lock and version count from
 * `SkillsLibrary.historySummary` (`SkillHistory`). A file whose name is not a safe
 * skill id has no history and reports zero, so one odd file never fails the list.
 */
export async function wirePersonalitySkill(
  library: SkillsLibrary,
  personalityId: string,
  record: PersonalitySkillRecord,
): Promise<PersonalitySkill> {
  const summary = await library.historySummary(record.id, personalityId);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    modifiedAt: record.modifiedAt,
    locked: summary.locked,
    versionCount: summary.versionCount,
  };
}
