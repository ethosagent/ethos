import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { filterSkill, warnMissingAllowList } from './ingest-filter';
import { sanitize } from './prompt-injection-guard';
import { applySubstitutions, parseSkillFrontmatter, shouldInject } from './skill-compat';
import { UniversalScanner } from './universal-scanner';
export class SkillsInjector {
  id = 'skills';
  priority = 100;
  personalities;
  globalSkillsDir;
  onSkip;
  storage;
  toolNamesForPersonality;
  maxInjectionChars;
  cache = new Map();
  scanner;
  constructor(personalities, optionsOrDir) {
    this.personalities = personalities;
    const opts =
      typeof optionsOrDir === 'string' ? { globalSkillsDir: optionsOrDir } : (optionsOrDir ?? {});
    this.globalSkillsDir = opts.globalSkillsDir ?? join(homedir(), '.ethos', 'skills');
    this.onSkip = opts.onSkip;
    this.storage = opts.storage ?? new FsStorage();
    this.toolNamesForPersonality = opts.toolNamesForPersonality;
    this.maxInjectionChars = opts.maxInjectionChars ?? 40_000;
    this.scanner = opts.scanner ?? new UniversalScanner({ storage: this.storage });
  }
  /**
   * Resolve the skill set visible to a personality WITHOUT building prompt
   * content — the eligibility decision only. Two sources:
   *   1. Per-personality `skills/` dirs — always included (OpenClaw
   *      `requires`/`os` rules still apply).
   *   2. Global pool — filtered through `filterSkill` + OpenClaw rules.
   *
   * `inject()` consumes this so "which skills does personality P see" lives
   * in exactly one place. Read-only surfaces that need the list but not the
   * prompt content (e.g. the Slack `/ethos personality rich` card) call it
   * directly.
   */
  async resolveSkills(personalityId) {
    const personality = personalityId
      ? (this.personalities.get(personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();
    const resolved = [];
    // 1. Per-personality skills/ dirs — always loaded unfiltered (hand-curated library)
    const perPersonalityDirs = personality.skillsDirs ?? [];
    for (const dir of perPersonalityDirs) {
      for (const filePath of await this.discoverSkillFiles(dir)) {
        const raw = await this.readCached(filePath);
        if (!raw) continue;
        const skillId = this.skillIdFor(filePath, dir);
        const parsed = parseSkillFrontmatter(raw);
        if (parsed) {
          const verdict = shouldInject(parsed.openclaw, {});
          if (!verdict.inject) {
            this.onSkip?.(skillId, verdict.reason ?? 'unknown');
            continue;
          }
        }
        resolved.push({ id: skillId, source: 'personality', filePath });
      }
    }
    // 2. Global pool from universal scanner — filtered per personality
    const globalPool = await this.scanner.scan();
    // Warn about missing allow-list references
    const allow = personality.skills?.global_ingest?.allow ?? [];
    if (allow.length > 0) {
      warnMissingAllowList(personality.id, allow, globalPool, (msg) =>
        process.stdout.write(`${msg}\n`),
      );
    }
    const toolNames = this.toolNamesForPersonality
      ? this.toolNamesForPersonality(personality)
      : new Set();
    for (const [, skill] of globalPool) {
      if (perPersonalityDirs.some((d) => skill.filePath.startsWith(d))) continue;
      const result = filterSkill(skill, personality, toolNames, (msg) =>
        process.stdout.write(`${msg}\n`),
      );
      if (!result.include) {
        this.onSkip?.(skill.qualifiedName, result.reason);
        continue;
      }
      if (skill.dialect === 'openclaw') {
        const parsed = parseSkillFrontmatter(
          skill.body.length > 0
            ? `---\n${JSON.stringify(skill.rawFrontmatter)}\n---\n${skill.body}`
            : skill.body,
        );
        if (parsed) {
          const verdict = shouldInject(parsed.openclaw, {});
          if (!verdict.inject) {
            this.onSkip?.(skill.qualifiedName, verdict.reason ?? 'openclaw filter');
            continue;
          }
        }
      }
      resolved.push({ id: skill.qualifiedName, source: 'global', skill });
    }
    return resolved;
  }
  async inject(ctx) {
    const personality = ctx.personalityId
      ? (this.personalities.get(ctx.personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();
    const resolved = await this.resolveSkills(ctx.personalityId);
    const sections = [];
    const fileNames = [];
    let totalChars = 0;
    const budget = this.maxInjectionChars;
    function addSection(content, name) {
      if (budget > 0 && totalChars + content.length > budget) return false;
      sections.push(content);
      fileNames.push(name);
      totalChars += content.length;
      return true;
    }
    // 1. Per-personality skills — always loaded unfiltered (hand-curated library)
    for (const r of resolved) {
      if (r.source !== 'personality') continue;
      const raw = await this.readCached(r.filePath);
      if (!raw) continue;
      const parsed = parseSkillFrontmatter(raw);
      const body = parsed ? parsed.body : raw;
      const substituted = applySubstitutions(body, dirname(r.filePath), ctx.sessionId);
      addSection(sanitize(substituted.trim()), r.id);
    }
    // 2. Global pool from universal scanner — filtered per personality (resolved above)
    const eligibleGlobal = resolved.flatMap((r) => (r.source === 'global' ? [r.skill] : []));
    // Determine injection mode for global-pool skills.
    // 'index' (default) injects a compact table; 'full' injects complete bodies.
    const injectionMode = personality.skills?.injection_mode ?? 'index';
    if (injectionMode === 'index') {
      // Phase 1: compact index table — the LLM calls get_skill() for full bodies
      if (eligibleGlobal.length > 0) {
        const rows = eligibleGlobal
          .map((s) => {
            const desc = s.rawFrontmatter.description ?? '—';
            return `| \`${s.qualifiedName}\` | ${desc} |`;
          })
          .join('\n');
        const indexBlock =
          `## Available Skills\n\n` +
          `Call \`get_skill(name)\` to load full instructions before using any skill.\n\n` +
          `| Skill | Description |\n` +
          `|---|---|\n` +
          rows;
        sections.push(indexBlock);
        fileNames.push('__skill_index__');
      }
    } else {
      // Phase 1 (full mode): inject complete bodies, respecting budget
      let budgetExceeded = false;
      for (const skill of eligibleGlobal) {
        const substituted = applySubstitutions(skill.body, dirname(skill.filePath), ctx.sessionId);
        const content = sanitize(substituted.trim());
        if (!addSection(content, skill.qualifiedName)) {
          budgetExceeded = true;
          this.onSkip?.(skill.qualifiedName, 'injection budget exceeded');
        }
      }
      if (budgetExceeded) {
        process.stdout.write(
          `[skills] injection budget (${budget} chars) reached — some global-pool skills were skipped. ` +
            `Switch to injection_mode: index or use skills.global_ingest.mode: explicit to pin specific skills.\n`,
        );
      }
    }
    if (sections.length === 0) return null;
    ctx.meta ??= {};
    ctx.meta.skillFilesUsed = fileNames.filter((n) => n !== '__skill_index__');
    return {
      content: `## Skills\n\n${sections.join('\n\n---\n\n')}`,
      position: 'append',
    };
  }
  async discoverSkillFiles(dir) {
    const found = [];
    const entries = await this.storage.listEntries(dir);
    if (entries.length === 0) return [];
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDir) {
        if (entry.name === 'pending' || entry.name.startsWith('.')) continue;
        const subPath = join(dir, entry.name);
        const skillMd = join(subPath, 'SKILL.md');
        if (await this.fileExists(skillMd)) {
          found.push(skillMd);
          continue;
        }
        const inner = await this.storage.listEntries(subPath);
        for (const child of [...inner].sort((a, b) => a.name.localeCompare(b.name))) {
          if (!child.isDir) continue;
          const nested = join(subPath, child.name, 'SKILL.md');
          if (await this.fileExists(nested)) found.push(nested);
        }
      } else if (entry.name.endsWith('.md')) {
        found.push(join(dir, entry.name));
      }
    }
    return found;
  }
  skillIdFor(filePath, rootDir) {
    if (basename(filePath) !== 'SKILL.md') return basename(filePath);
    const parentDir = dirname(filePath);
    const grandparent = dirname(parentDir);
    if (grandparent === rootDir) return basename(parentDir);
    return `${basename(grandparent)}/${basename(parentDir)}`;
  }
  async readCached(filePath) {
    const mtimeMs = await this.storage.mtime(filePath);
    if (mtimeMs === null) return null;
    const cached = this.cache.get(filePath);
    if (cached && cached.mtime === mtimeMs) return cached.content;
    const content = await this.storage.read(filePath);
    if (content === null) return null;
    this.cache.set(filePath, { mtime: mtimeMs, content });
    return content;
  }
  async fileExists(path) {
    const t = await this.storage.mtime(path);
    return t !== null;
  }
}
