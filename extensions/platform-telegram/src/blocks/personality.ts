/**
 * Telegram character sheet card — the `/personality rich` rendering for
 * Telegram. Mirrors the Slack `personalityRichBlocks` but outputs plain
 * Markdown text instead of Block Kit. Same redactions as Slack: fs_reach,
 * MCP servers, and plugins are omitted.
 */

/**
 * The resolved character-sheet data behind `/personality rich`. Structural
 * clone of the Slack `PersonalityCard` — defined locally so the Telegram
 * package doesn't depend on `@ethosagent/platform-slack`. Both surfaces
 * consume the same shape; the gateway wiring builds the card once and
 * passes it to whichever surface needs it.
 */
export interface PersonalityCard {
  id: string;
  name: string;
  description: string;
  /** First paragraph of ETHOS.md — the personality's own voice. '' when absent. */
  prose: string;
  model: string;
  provider: string;
  toolset: string[];
  skills: Array<{ id: string; source: 'personality' | 'global' }>;
}

// Per-section caps so one field can't blow past Telegram's 4096-char limit.
const TOOLS_MAX = 1200;
const SKILLS_MAX = 1200;
const TOTAL_MAX = 4096;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

export interface PersonalityRichOpts {
  mode?: 'markdown' | 'html';
}

export function personalityRichMessage(card: PersonalityCard, opts?: PersonalityRichOpts): string {
  const html = opts?.mode === 'html';
  const b = (t: string) => (html ? `<b>${t}</b>` : `*${t}*`);
  const i = (t: string) => (html ? `<i>${t}</i>` : `_${t}_`);
  const code = (t: string) => (html ? `<code>${t}</code>` : `\`${t}\``);

  const lines: string[] = [];

  // Header
  lines.push(b(card.name));
  lines.push('');

  // Identity — description plus the personality's own ETHOS.md voice.
  if (card.description) lines.push(card.description);
  if (card.prose) lines.push(i(card.prose));
  if (card.description || card.prose) lines.push('');

  // Routing
  lines.push(`${b('Runs on:')} ${card.model} via ${card.provider}`);
  lines.push(`${b('Remembers:')} MEMORY.md, USER.md`);
  lines.push('');

  // Tools
  const toolCount = card.toolset.length;
  const toolLabel = `${b('What it can do')} — ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
  if (toolCount > 0) {
    const toolList = truncate(card.toolset.map((t) => code(t)).join(', '), TOOLS_MAX);
    lines.push(toolLabel);
    lines.push(toolList);
  } else {
    lines.push(toolLabel);
    lines.push(i('No tools — this personality can only converse.'));
  }
  lines.push('');

  // Skills
  const skillCount = card.skills.length;
  const skillLabel = `${b('What it knows')} — ${skillCount} skill${skillCount === 1 ? '' : 's'}`;
  if (skillCount > 0) {
    const skillList = truncate(
      card.skills.map((s) => `${code(s.id)} (${s.source})`).join('\n'),
      SKILLS_MAX,
    );
    lines.push(skillLabel);
    lines.push(skillList);
  } else {
    lines.push(skillLabel);
    lines.push(i('No skills resolved for this personality.'));
  }

  const result = lines.join('\n');
  return truncate(result, TOTAL_MAX);
}
