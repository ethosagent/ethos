// FW-§9.4 — file-drop command scanning and cache helpers.

import { join } from 'node:path';
import { parseSkillFrontmatter } from '@ethosagent/skills';
import type { Storage } from '@ethosagent/types';
import type { SlashCommandRegistry } from './slash-commands';

export type CommandScope = 'global' | 'project' | 'personality';

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  prompt: string;
  allowedTools?: string[];
  scope: CommandScope;
}

export interface CommandMeta {
  filePath: string;
  mtimeMs: number;
  definition: CommandDefinition;
}

/**
 * Scan `commands/` directories and register each `.md` file as a prompt-mediated
 * CommandDefinition. Supports global, project, and personality scopes.
 *
 * Directories:
 *   - global:      `~/.ethos/commands/`
 *   - project:     `.ethos/commands/` (cwd-relative)
 *   - personality:  `~/.ethos/personalities/<id>/commands/`
 */
export async function scanCommandsIntoRegistry(
  storage: Storage,
  dirs: { path: string; scope: CommandScope }[],
  registry: SlashCommandRegistry,
  commandCache: Map<string, CommandMeta>,
): Promise<void> {
  for (const { path: dir, scope } of dirs) {
    const names = await storage.list(dir);
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -3);
      const filePath = join(dir, name);
      const mtimeMs = (await storage.mtime(filePath)) ?? Date.now();
      const content = await storage.read(filePath);
      if (!content) continue;

      const parsed = parseSkillFrontmatter(content);
      const description = parsed?.description ?? `Command: ${slug}`;
      const raw = parsed?.raw ?? {};
      const body = parsed?.body ?? content;

      const allowedToolsRaw = raw['allowed-tools'];
      const allowedTools = Array.isArray(allowedToolsRaw)
        ? allowedToolsRaw.filter((t): t is string => typeof t === 'string')
        : typeof allowedToolsRaw === 'string'
          ? allowedToolsRaw
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;

      const definition: CommandDefinition = {
        name: slug,
        description,
        argumentHint: typeof raw['argument-hint'] === 'string' ? raw['argument-hint'] : undefined,
        prompt: body.trim(),
        allowedTools,
        scope,
      };

      commandCache.set(slug, { filePath, mtimeMs, definition });
      registry.register({
        name: slug,
        description,
        usage: definition.argumentHint ? `/${slug} ${definition.argumentHint}` : `/${slug}`,
        prefix: '[command]',
      });
    }
  }
}

/**
 * Re-read a command file if its mtime has advanced. Returns the (possibly
 * refreshed) `CommandMeta`, or `undefined` if the slug is not in the cache.
 */
export async function refreshCommandIfStale(
  storage: Storage,
  slug: string,
  commandCache: Map<string, CommandMeta>,
): Promise<CommandMeta | undefined> {
  const meta = commandCache.get(slug);
  if (!meta) return undefined;
  const currentMtime = (await storage.mtime(meta.filePath)) ?? meta.mtimeMs;
  if (currentMtime !== meta.mtimeMs) {
    const freshContent = await storage.read(meta.filePath);
    if (freshContent) {
      const parsed = parseSkillFrontmatter(freshContent);
      const raw = parsed?.raw ?? {};
      const body = parsed?.body ?? freshContent;
      const description = parsed?.description ?? meta.definition.description;

      const allowedToolsRaw = raw['allowed-tools'];
      const allowedTools = Array.isArray(allowedToolsRaw)
        ? allowedToolsRaw.filter((t): t is string => typeof t === 'string')
        : typeof allowedToolsRaw === 'string'
          ? allowedToolsRaw
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;

      meta.definition = {
        ...meta.definition,
        description,
        argumentHint: typeof raw['argument-hint'] === 'string' ? raw['argument-hint'] : undefined,
        prompt: body.trim(),
        allowedTools,
      };
      meta.mtimeMs = currentMtime;
    }
  }
  return meta;
}
