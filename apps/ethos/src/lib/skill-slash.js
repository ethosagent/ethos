// FW-15 — skill scanning and cache helpers extracted for testability.
import { join } from 'node:path';
import { parseSkillFrontmatter } from '@ethosagent/skills';
/**
 * Walk `skillsDir` (and optionally `personalitySkillsDir`) and register every
 * `.md` file as a `[skill]`-prefixed slash command in `registry`.
 */
export async function scanSkillsIntoRegistry(
  storage,
  skillsDir,
  personalitySkillsDir,
  registry,
  skillCache,
) {
  const dirs = [skillsDir];
  if (personalitySkillsDir) dirs.push(personalitySkillsDir);
  for (const dir of dirs) {
    const names = await storage.list(dir);
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -3);
      const filePath = join(dir, name);
      const mtimeMs = (await storage.mtime(filePath)) ?? Date.now();
      const content = await storage.read(filePath);
      if (!content) continue;
      const parsed = parseSkillFrontmatter(content);
      const description = parsed?.description ?? `Skill: ${slug}`;
      const usage = parsed?.usage;
      skillCache.set(slug, { filePath, mtimeMs, content, usage, description });
      registry.register({ name: slug, description, usage: usage ?? `/${slug}`, prefix: '[skill]' });
    }
  }
}
/**
 * Re-read a skill file if its mtime has advanced. Returns the (possibly
 * refreshed) `SkillMeta`, or `undefined` if the slug is not in the cache.
 */
export async function refreshSkillIfStale(storage, slug, skillCache) {
  const meta = skillCache.get(slug);
  if (!meta) return undefined;
  const currentMtime = (await storage.mtime(meta.filePath)) ?? meta.mtimeMs;
  if (currentMtime !== meta.mtimeMs) {
    const freshContent = await storage.read(meta.filePath);
    if (freshContent) {
      const parsed = parseSkillFrontmatter(freshContent);
      meta.content = freshContent;
      meta.mtimeMs = currentMtime;
      meta.usage = parsed?.usage;
      meta.description = parsed?.description;
    }
  }
  return meta;
}
