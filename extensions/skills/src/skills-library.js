import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { assertSafeId, EthosError } from '@ethosagent/types';
import { parseSkillFrontmatter } from './skill-compat';
export class SkillsLibrary {
  storage;
  skillsDir;
  pendingDir;
  personalitiesDir;
  catalogDir;
  catalogIndex = null;
  constructor(opts) {
    this.storage = opts.storage ?? new FsStorage();
    this.skillsDir = join(opts.dataDir, 'skills');
    this.pendingDir = join(this.skillsDir, '.pending');
    this.personalitiesDir = join(opts.dataDir, 'personalities');
    this.catalogDir = opts.catalogDir ?? null;
  }
  /** Absolute path to the directory holding live (global) skills. */
  getSkillsDir() {
    return this.skillsDir;
  }
  /** Absolute path to the pending-candidates directory. */
  getPendingDir() {
    return this.pendingDir;
  }
  // ---------------------------------------------------------------------------
  // Global skills
  // ---------------------------------------------------------------------------
  async listSkills() {
    const systemSkills = await this.readSystemSkills();
    const names = await this.storage.list(this.skillsDir);
    const userSkills = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const skill = await this.readGlobal(name);
      if (skill) userSkills.push(skill);
    }
    const userIds = new Set(userSkills.map((s) => s.id));
    const merged = [...systemSkills.filter((s) => !userIds.has(s.id)), ...userSkills];
    merged.sort((a, b) => a.name.localeCompare(b.name));
    return merged;
  }
  async getSkill(id) {
    assertSafeId(id, 'skillId');
    const user = await this.readGlobal(`${id}.md`);
    if (user) return user;
    return this.readSystemSkill(id);
  }
  async createSkill(id, body) {
    assertSafeId(id, 'skillId');
    await this.storage.mkdir(this.skillsDir);
    const path = join(this.skillsDir, `${id}.md`);
    if (await this.storage.exists(path)) {
      throw new EthosError({
        code: 'SKILL_EXISTS',
        cause: `A skill named "${id}" already exists.`,
        action: 'Pick a different id or open the existing skill to edit it.',
      });
    }
    await this.storage.write(path, ensureTrailingNewline(body));
    const created = await this.readGlobal(`${id}.md`);
    if (!created) throw new Error(`createSkill: failed to read back ${id}`);
    return created;
  }
  async updateSkill(id, body) {
    assertSafeId(id, 'skillId');
    const path = join(this.skillsDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.write(path, ensureTrailingNewline(body));
    const updated = await this.readGlobal(`${id}.md`);
    if (!updated) throw new Error(`updateSkill: failed to read back ${id}`);
    return updated;
  }
  async deleteSkill(id) {
    assertSafeId(id, 'skillId');
    const path = join(this.skillsDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.remove(path);
  }
  // ---------------------------------------------------------------------------
  // Pending queue (evolver outputs)
  // ---------------------------------------------------------------------------
  async listPending() {
    const names = await this.storage.list(this.pendingDir);
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const path = join(this.pendingDir, name);
      const raw = await this.storage.read(path);
      const mtimeMs = await this.storage.mtime(path);
      if (raw === null || mtimeMs === null) continue;
      const id = name.replace(/\.md$/, '');
      const parsed = parseSkillFrontmatter(raw);
      const body = parsed?.body ?? raw;
      const fm = parsed?.raw ?? {};
      out.push({
        id,
        name: typeof fm.name === 'string' ? fm.name : id,
        description: typeof fm.description === 'string' ? fm.description : null,
        body,
        proposedAt: new Date(mtimeMs).toISOString(),
      });
    }
    out.sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : -1));
    return out;
  }
  async pendingExists(id) {
    assertSafeId(id, 'skillId');
    return this.storage.exists(join(this.pendingDir, `${id}.md`));
  }
  /** Move `<id>.md` from pending → live, replacing any existing live skill. */
  async approvePending(id) {
    assertSafeId(id, 'skillId');
    const src = join(this.pendingDir, `${id}.md`);
    const body = await this.storage.read(src);
    if (body === null) throw notFoundGlobal(id);
    await this.storage.mkdir(this.skillsDir);
    await this.storage.write(join(this.skillsDir, `${id}.md`), body);
    await this.storage.remove(src);
  }
  async rejectPending(id) {
    assertSafeId(id, 'skillId');
    const path = join(this.pendingDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.remove(path);
  }
  // ---------------------------------------------------------------------------
  // Per-personality skills
  // ---------------------------------------------------------------------------
  async listPersonalitySkills(personalityId) {
    assertSafeId(personalityId, 'personalityId');
    const dir = this.personalitySkillsDir(personalityId);
    const names = await this.storage.list(dir);
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const skill = await this.readPersonalitySkill(dir, name);
      if (skill) out.push(skill);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  async getPersonalitySkill(personalityId, skillId) {
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
    return this.readPersonalitySkill(this.personalitySkillsDir(personalityId), `${skillId}.md`);
  }
  async createPersonalitySkill(personalityId, skillId, body) {
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
    const dir = this.personalitySkillsDir(personalityId);
    await this.storage.mkdir(dir);
    const path = join(dir, `${skillId}.md`);
    if (await this.storage.exists(path)) {
      throw new EthosError({
        code: 'SKILL_EXISTS',
        cause: `Skill "${skillId}" already exists for personality "${personalityId}".`,
        action: 'Pick a different id or open the existing skill to edit it.',
      });
    }
    await this.storage.write(path, ensureTrailingNewline(body));
    const created = await this.readPersonalitySkill(dir, `${skillId}.md`);
    if (!created) throw new Error(`createPersonalitySkill: failed to read back ${skillId}`);
    return created;
  }
  async updatePersonalitySkill(personalityId, skillId, body) {
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
    const dir = this.personalitySkillsDir(personalityId);
    const path = join(dir, `${skillId}.md`);
    if (!(await this.storage.exists(path))) throw notFoundPersonality(skillId);
    await this.storage.write(path, ensureTrailingNewline(body));
    const updated = await this.readPersonalitySkill(dir, `${skillId}.md`);
    if (!updated) throw new Error(`updatePersonalitySkill: failed to read back ${skillId}`);
    return updated;
  }
  async deletePersonalitySkill(personalityId, skillId) {
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
    const path = join(this.personalitySkillsDir(personalityId), `${skillId}.md`);
    if (!(await this.storage.exists(path))) throw notFoundPersonality(skillId);
    await this.storage.remove(path);
  }
  /**
   * Copy global skills into the personality's skills/ dir, byte-for-byte
   * matching the global file (so the SkillsInjector sees identical content
   * via mtime cache). Existing per-personality skills with the same id are
   * silently overwritten — the user explicitly chose to import.
   */
  async importGlobalIntoPersonality(personalityId, skillIds) {
    assertSafeId(personalityId, 'personalityId');
    for (const sid of skillIds) assertSafeId(sid, 'skillId');
    const dir = this.personalitySkillsDir(personalityId);
    await this.storage.mkdir(dir);
    const imported = [];
    for (const skillId of skillIds) {
      const sourceRaw = await this.resolveSkillContent(skillId);
      if (sourceRaw === null) {
        throw new EthosError({
          code: 'SKILL_NOT_FOUND',
          cause: `Skill "${skillId}" not found in user skills or system catalog.`,
          action: 'Use listSkills() to see what is available.',
        });
      }
      await this.storage.write(join(dir, `${skillId}.md`), sourceRaw);
      const created = await this.readPersonalitySkill(dir, `${skillId}.md`);
      if (created) imported.push(created);
    }
    return imported;
  }
  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------
  personalitySkillsDir(personalityId) {
    return join(this.personalitiesDir, personalityId, 'skills');
  }
  async readGlobal(filename) {
    const path = join(this.skillsDir, filename);
    const raw = await this.storage.read(path);
    const mtimeMs = await this.storage.mtime(path);
    if (raw === null || mtimeMs === null) return null;
    const id = filename.replace(/\.md$/, '');
    const parsed = parseSkillFrontmatter(raw);
    const fm = parsed?.raw ?? {};
    const body = parsed?.body ?? raw;
    return {
      id,
      name: typeof fm.name === 'string' ? fm.name : id,
      description: typeof fm.description === 'string' ? fm.description : null,
      frontmatter: fm,
      body,
      modifiedAt: new Date(mtimeMs).toISOString(),
      source: 'user',
      readonly: false,
    };
  }
  async readPersonalitySkill(dir, filename) {
    const path = join(dir, filename);
    const raw = await this.storage.read(path);
    const mtimeMs = await this.storage.mtime(path);
    if (raw === null || mtimeMs === null) return null;
    const id = filename.replace(/\.md$/, '');
    const parsed = parseSkillFrontmatter(raw);
    const fm = parsed?.raw ?? {};
    const body = parsed?.body ?? raw;
    return {
      id,
      name: typeof fm.name === 'string' ? fm.name : id,
      description: typeof fm.description === 'string' ? fm.description : null,
      body,
      modifiedAt: new Date(mtimeMs).toISOString(),
    };
  }
  async getCatalogIndex() {
    if (this.catalogIndex) return this.catalogIndex;
    const index = new Map();
    if (!this.catalogDir) {
      this.catalogIndex = index;
      return index;
    }
    const entries = await this.storage.listEntries(this.catalogDir);
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const directPath = join(this.catalogDir, entry.name, 'SKILL.md');
      if (await this.storage.exists(directPath)) {
        const existing = index.get(entry.name);
        if (existing) {
          throw new EthosError({
            code: 'SKILL_EXISTS',
            cause: `Duplicate system skill id "${entry.name}" found at "${directPath}" and "${existing}".`,
            action: 'Rename one of the skills so each leaf directory has a unique name.',
          });
        }
        index.set(entry.name, directPath);
        continue;
      }
      const subEntries = await this.storage.listEntries(join(this.catalogDir, entry.name));
      for (const sub of subEntries) {
        if (!sub.isDir) continue;
        const nestedPath = join(this.catalogDir, entry.name, sub.name, 'SKILL.md');
        if (await this.storage.exists(nestedPath)) {
          const existing = index.get(sub.name);
          if (existing) {
            throw new EthosError({
              code: 'SKILL_EXISTS',
              cause: `Duplicate system skill id "${sub.name}" found at "${nestedPath}" and "${existing}".`,
              action: 'Rename one of the skills so each leaf directory has a unique name.',
            });
          }
          index.set(sub.name, nestedPath);
        }
      }
    }
    this.catalogIndex = index;
    return index;
  }
  async readSystemSkills() {
    const index = await this.getCatalogIndex();
    const out = [];
    for (const [id, path] of index) {
      const skill = await this.readSystemSkillAt(id, path);
      if (skill) out.push(skill);
    }
    return out;
  }
  async readSystemSkill(id) {
    const index = await this.getCatalogIndex();
    const path = index.get(id);
    if (!path) return null;
    return this.readSystemSkillAt(id, path);
  }
  async readSystemSkillAt(id, path) {
    const raw = await this.storage.read(path);
    const mtimeMs = await this.storage.mtime(path);
    if (raw === null || mtimeMs === null) return null;
    const parsed = parseSkillFrontmatter(raw);
    const fm = parsed?.raw ?? {};
    const body = parsed?.body ?? raw;
    return {
      id,
      name: typeof fm.name === 'string' ? fm.name : id,
      description: typeof fm.description === 'string' ? fm.description : null,
      frontmatter: fm,
      body,
      modifiedAt: new Date(mtimeMs).toISOString(),
      source: 'system',
      readonly: true,
    };
  }
  /** Try user skillsDir first, then catalogDir. Returns raw file content. */
  async resolveSkillContent(skillId) {
    const userPath = join(this.skillsDir, `${skillId}.md`);
    const userRaw = await this.storage.read(userPath);
    if (userRaw !== null) return userRaw;
    const index = await this.getCatalogIndex();
    const systemPath = index.get(skillId);
    if (!systemPath) return null;
    return this.storage.read(systemPath);
  }
}
function ensureTrailingNewline(s) {
  return s.endsWith('\n') ? s : `${s}\n`;
}
function notFoundGlobal(id) {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use listSkills() to see what is currently installed.',
  });
}
function notFoundPersonality(id) {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use listPersonalitySkills() to see what is installed for this personality.',
  });
}
