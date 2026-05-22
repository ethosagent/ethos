import {
  type CreatePersonalityInput,
  type DescribedPersonality,
  type FilePersonalityRegistry,
  renderCharacterSheet,
  type UpdatePersonalityPatch,
} from '@ethosagent/personalities';
import type { PersonalitySkillRecord, SkillsLibrary } from '@ethosagent/skills';
import { EthosError, resolveModelDisplay } from '@ethosagent/types';
import type { McpPolicy, Personality, PersonalitySkill } from '@ethosagent/web-contracts';

// Personalities service. Calls into FilePersonalityRegistry for the
// directory-level CRUD (create/update/delete/duplicate) and into
// SkillsLibrary for the per-personality skills/ subdir. Both extensions
// own their own Storage layer; the service is a thin wire-shape mapper.

export interface PersonalitiesServiceOptions {
  personalities: FilePersonalityRegistry;
  library: SkillsLibrary;
}

export class PersonalitiesService {
  constructor(private readonly opts: PersonalitiesServiceOptions) {}

  list(): { items: Personality[]; nextCursor: string | null; defaultId: string } {
    return {
      items: this.opts.personalities.describeAll().map(toWire),
      nextCursor: null,
      defaultId: this.opts.personalities.getDefault().id,
    };
  }

  async get(
    id: string,
  ): Promise<{ personality: Personality; soulMd: string; mcpPolicy: McpPolicy | null }> {
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    const soulMd = await this.opts.personalities.readSoulMd(id);
    return { personality: toWire(described), soulMd, mcpPolicy: described.mcpPolicy ?? null };
  }

  /** Generated Markdown character sheet — the same artifact `ethos personality
   *  show` prints, rendered for the Web Personalities tab. */
  async characterSheet(id: string): Promise<{ markdown: string }> {
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    const soulMd = await this.opts.personalities.readSoulMd(id);
    return { markdown: renderCharacterSheet(described.config, soulMd) };
  }

  async create(input: CreatePersonalityInput): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.create(input);
    return { personality: toWire(created) };
  }

  async update(id: string, patch: UpdatePersonalityPatch): Promise<{ personality: Personality }> {
    const updated = await this.opts.personalities.update(id, patch);
    return { personality: toWire(updated) };
  }

  /**
   * Write per-server MCP tool subsets into the personality's `mcp.yaml`.
   * `subsets` maps a server name to either an explicit bare-tool-name list
   * (a strict subset) or `null` to clear any prior subset (all tools
   * allowed). Delegates to the registry, which preserves `reject_args`.
   */
  async writeMcpToolSubsets(id: string, subsets: Record<string, string[] | null>): Promise<void> {
    await this.opts.personalities.writeMcpToolSubsets(id, subsets);
  }

  async delete(id: string): Promise<void> {
    await this.opts.personalities.deletePersonality(id);
  }

  async duplicate(id: string, newId: string): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.duplicate(id, newId);
    return { personality: toWire(created) };
  }

  // ---------------------------------------------------------------------------
  // Per-personality skills (gate 19)
  // ---------------------------------------------------------------------------

  async skillsList(personalityId: string): Promise<{ skills: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.listPersonalitySkills(personalityId);
    return { skills: records.map(toWirePersonalitySkill) };
  }

  async skillsGet(personalityId: string, skillId: string): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.getPersonalitySkill(personalityId, skillId);
    if (!skill) {
      throw new EthosError({
        code: 'SKILL_NOT_FOUND',
        cause: `Skill "${skillId}" not found for personality "${personalityId}".`,
        action: 'Use personalities.skillsList to see installed skills.',
      });
    }
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsCreate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.createPersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsUpdate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.updatePersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsDelete(personalityId: string, skillId: string): Promise<void> {
    this.requirePersonality(personalityId);
    await this.opts.library.deletePersonalitySkill(personalityId, skillId);
  }

  async skillsImportGlobal(
    personalityId: string,
    skillIds: string[],
  ): Promise<{ imported: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.importGlobalIntoPersonality(personalityId, skillIds);
    return { imported: records.map(toWirePersonalitySkill) };
  }

  private requirePersonality(id: string): void {
    if (!this.opts.personalities.describe(id)) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use personalities.list to see available ids.',
      });
    }
  }
}

function toWirePersonalitySkill(record: PersonalitySkillRecord): PersonalitySkill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    modifiedAt: record.modifiedAt,
  };
}

function toWire(d: DescribedPersonality): Personality {
  const c = d.config;
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? null,
    model: resolveModelDisplay(c.model, '') || null,
    provider: c.provider ?? null,
    toolset: c.toolset ?? null,
    capabilities: c.capabilities ?? null,
    memoryScope: c.memoryScope ?? null,
    streamingTimeoutMs: c.streamingTimeoutMs ?? null,
    mcp_servers: c.mcp_servers ?? null,
    plugins: c.plugins ?? null,
    fs_reach: c.fs_reach
      ? { read: c.fs_reach.read ?? null, write: c.fs_reach.write ?? null }
      : null,
    builtin: d.builtin,
    version: 1,
  };
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'PERSONALITY_NOT_FOUND',
    cause: `Personality "${id}" not found`,
    action: 'Call `personalities.list` to see available IDs.',
  });
}
