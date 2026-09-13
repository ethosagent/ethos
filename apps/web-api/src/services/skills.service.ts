import type { SkillRecord, SkillsLibrary } from '@ethosagent/skills';
import { EthosError } from '@ethosagent/types';
import type { Skill } from '@ethosagent/web-contracts';

// Skills library service. Calls into @ethosagent/skills' SkillsLibrary
// directly — wire-shape mapping happens here. The pending-queue mutations
// (approve/reject) live on EvolverService per the plan's namespace split.

export interface SkillsServiceOptions {
  library: SkillsLibrary;
  /**
   * Skill candidates waiting in the learning inbox — the "Approval queue"
   * badge. Borrowed from `LearningService` at wiring time (L-T8); absent → 0.
   */
  pendingCount?: () => Promise<number>;
}

export class SkillsService {
  constructor(private readonly opts: SkillsServiceOptions) {}

  async list(opts?: {
    includeUnavailable?: boolean;
  }): Promise<{ skills: Skill[]; pendingCount: number }> {
    const [skills, pendingCount] = await Promise.all([
      this.opts.library.listSkills({ includeUnavailable: opts?.includeUnavailable }),
      this.opts.pendingCount ? this.opts.pendingCount() : Promise.resolve(0),
    ]);
    return { skills: skills.map(toWire), pendingCount };
  }

  async get(id: string): Promise<{ skill: Skill }> {
    const skill = await this.opts.library.getSkill(id);
    if (!skill) throw notFound(id);
    return { skill: toWire(skill) };
  }

  async create(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const skill = await this.opts.library.createSkill(input.id, input.body);
    return { skill: toWire(skill) };
  }

  async update(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const existing = await this.opts.library.getSkill(input.id);
    if (existing?.source === 'system') throw readonlyError();
    const skill = await this.opts.library.updateSkill(input.id, input.body);
    return { skill: toWire(skill) };
  }

  async delete(id: string): Promise<void> {
    const existing = await this.opts.library.getSkill(id);
    if (existing?.source === 'system') throw readonlyError();
    await this.opts.library.deleteSkill(id);
  }
}

function toWire(record: SkillRecord): Skill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    frontmatter: record.frontmatter,
    body: record.body,
    modifiedAt: record.modifiedAt,
    source: record.source,
    readonly: record.readonly,
    unavailableReason: record.unavailableReason,
  };
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use skills.list to see what is currently installed.',
  });
}

function readonlyError(): EthosError {
  return new EthosError({
    code: 'SKILL_READONLY',
    cause: 'System skills are read-only.',
    action: 'Only user-created skills can be modified or deleted.',
  });
}
