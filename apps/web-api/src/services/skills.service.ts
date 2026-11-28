import type { SkillRecord, SkillsLibrary } from '@ethosagent/skills';
import { EthosError } from '@ethosagent/types';
import type { Skill, SkillVersion } from '@ethosagent/web-contracts';

// Skills library service. Calls into @ethosagent/skills' SkillsLibrary
// directly — wire-shape mapping happens here. The pending-queue mutations
// (approve/reject) live on EvolverService per the plan's namespace split.

export interface SkillsServiceOptions {
  library: SkillsLibrary;
  /**
   * How many skill candidates wait in the learning inbox, returned as
   * `skills.list`'s `pendingCount`. Borrowed from `LearningService` at wiring
   * time (L-T8); absent → 0.
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
    return { skills: await Promise.all(skills.map((s) => this.wire(s))), pendingCount };
  }

  async get(id: string): Promise<{ skill: Skill }> {
    const skill = await this.opts.library.getSkill(id);
    if (!skill) throw notFound(id);
    return { skill: await this.wire(skill) };
  }

  async create(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const skill = await this.opts.library.createSkill(input.id, input.body);
    return { skill: await this.wire(skill) };
  }

  async update(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const existing = await this.opts.library.getSkill(input.id);
    if (existing?.source === 'system') throw readonlyError();
    const skill = await this.opts.library.updateSkill(input.id, input.body);
    return { skill: await this.wire(skill) };
  }

  async delete(id: string): Promise<void> {
    const existing = await this.opts.library.getSkill(id);
    if (existing?.source === 'system') throw readonlyError();
    await this.opts.library.deleteSkill(id);
  }

  // History and lock. `personalityId` selects a personality's own skill; omitted
  // is the shared one. All of it goes through `SkillsLibrary.history`
  // (`SkillHistory`), the one writer of live skill bytes.

  async history(input: SkillScope): Promise<{ versions: SkillVersion[] }> {
    const versions = await this.opts.library.history.versions(this.destination(input));
    return { versions };
  }

  async version(input: SkillScope & { versionId: string }): Promise<{
    versionId: string;
    content: string | null;
  }> {
    const content = await this.opts.library.history.readVersion(
      this.destination(input),
      input.versionId,
    );
    return { versionId: input.versionId, content };
  }

  async restore(input: SkillScope & { versionId: string }): Promise<{ versionId: string }> {
    return this.opts.library.history.restore(this.destination(input), input.versionId, 'web');
  }

  async setLock(input: SkillScope & { locked: boolean }): Promise<{ locked: boolean }> {
    const dest = this.destination(input);
    const existing = input.personalityId
      ? await this.opts.library.getPersonalitySkill(input.personalityId, input.id)
      : await this.opts.library.getSkill(input.id);
    if (existing && 'source' in existing && existing.source === 'system') throw readonlyError();
    if (!existing) throw notFound(input.id);
    await this.opts.library.history.setLock(dest, input.locked, 'web');
    return { locked: input.locked };
  }

  private destination(input: SkillScope): string {
    return this.opts.library.skillPath(input.id, input.personalityId);
  }

  private async wire(record: SkillRecord): Promise<Skill> {
    const summary =
      record.source === 'system'
        ? { locked: false, versionCount: 0 }
        : await this.opts.library.historySummary(record.id);
    return toWire(record, summary);
  }
}

interface SkillScope {
  id: string;
  personalityId?: string | undefined;
}

function toWire(record: SkillRecord, summary: { locked: boolean; versionCount: number }): Skill {
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
    locked: summary.locked,
    versionCount: summary.versionCount,
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
