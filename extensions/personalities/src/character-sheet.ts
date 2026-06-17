import { type PersonalityConfig, resolveModelDisplay } from '@ethosagent/types';
import { parseLivingSoul } from './living-soul';

// The generated character sheet — the "tight character sheet" promise from
// SOUL.md made into a real artifact. One Markdown screen per personality:
// what it is, what it has, what it can reach. Regenerated on demand from
// the personality's config + SOUL.md; never stored. The CLI
// (`ethos personality show`) and the Web Personalities tab both render
// this single source.

/**
 * The prose directly under the SOUL.md title — the personality's own
 * voice describing who it is. Returns `''` when the document has no body
 * paragraph (heading-only or empty file). Exported so surfaces that build
 * their own character-sheet rendering (e.g. the Slack `/ethos personality
 * rich` card) extract the identity line the same way the canonical sheet
 * does.
 */
export function firstParagraph(soulMd: string): string {
  const para: string[] = [];
  for (const line of soulMd.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // skip heading lines
    if (trimmed === '') {
      if (para.length > 0) break; // blank line closes the first paragraph
      continue; // skip leading blank lines
    }
    para.push(trimmed);
  }
  return para.join(' ');
}

function bulletList(items: readonly string[], emptyLabel: string): string[] {
  if (items.length === 0) return [`- ${emptyLabel}`];
  return items.map((item) => `- ${item}`);
}

/**
 * Render a personality's character sheet as Markdown. Pure — takes the
 * loaded config and the SOUL.md body, returns the artifact. Optional
 * fields render as explicit `(none)` / `(engine default)` states so a
 * reader never has to guess whether a blank means "unset" or "missing".
 */
export function renderCharacterSheet(config: PersonalityConfig, soulMd: string): string {
  const lines: string[] = [`# ${config.id} — ${config.name}`, ''];

  if (config.description) lines.push(config.description, '');

  const prose = firstParagraph(soulMd);
  if (prose) lines.push(prose, '');

  lines.push('## Routing');
  lines.push(`- Model: ${resolveModelDisplay(config.model, '(engine default)')}`);
  lines.push(`- Provider: ${config.provider ?? '(engine default)'}`);
  lines.push('');

  lines.push('## Capabilities');
  lines.push(...bulletList(config.capabilities ?? [], '(none)'));
  lines.push('');

  lines.push('## Memory');
  lines.push(`- Memory scope: personality:${config.id}`);
  lines.push('');

  const toolset = config.toolset ?? [];
  lines.push('## Toolset');
  if (toolset.length > 0) {
    lines.push(`${toolset.length} tool${toolset.length === 1 ? '' : 's'}:`);
  }
  lines.push(...bulletList(toolset, '(none)'));
  lines.push('');

  lines.push('## MCP servers');
  lines.push(...bulletList(config.mcp_servers ?? [], '(none)'));
  lines.push('');

  lines.push('## Plugins');
  lines.push(...bulletList(config.plugins ?? [], '(none)'));
  lines.push('');

  lines.push('## Filesystem reach');
  const reach = config.fs_reach;
  const read = reach?.read ?? [];
  const write = reach?.write ?? [];
  if (read.length > 0 || write.length > 0) {
    lines.push(`- Read: ${read.length > 0 ? read.join(', ') : '(none)'}`);
    lines.push(`- Write: ${write.length > 0 ? write.join(', ') : '(none)'}`);
  } else {
    lines.push('- (default — personality directory only)');
  }

  const soul = parseLivingSoul(soulMd);
  const isLivingSoul = soul.expression !== '' || soul.learningLog.length > 0;
  if (isLivingSoul) {
    lines.push('');
    lines.push('## Living Soul');
    const coreLineCount = soul.core.split('\n').filter((l) => l.trim() !== '').length;
    lines.push(
      `- Core: immutable identity (${coreLineCount} line${coreLineCount === 1 ? '' : 's'})`,
    );
    lines.push('');
    lines.push('### Expression');
    lines.push(soul.expression.trim() === '' ? '(empty)' : soul.expression.trim());
    lines.push('');
    lines.push('### Learning Log');
    if (soul.learningLog.length === 0) {
      lines.push('- (no changes yet)');
    } else {
      for (const e of soul.learningLog) {
        lines.push(`- ${e.at} · ${e.revisionId} · ${e.summary}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
