// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${self}` / `${shared}` tokens in config.yaml — they resolve at
// AgentLoop construction, not in the registry, so the renderer sees them verbatim.
import { describe, expect, it } from 'vitest';
import { renderCharacterSheet } from '../character-sheet';

// The character sheet is the SOUL.md "tight character sheet" promise made
// into a real artifact — one Markdown screen that says what a personality
// is, what it has, and what it can reach. `renderCharacterSheet` is the
// single generator both the CLI (`ethos personality show`) and the Web
// Personalities tab render.
const fullConfig = {
  id: 'engineer',
  name: 'Engineer',
  description: 'Terse, code-first agent that writes working code immediately.',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  toolset: ['read_file', 'write_file', 'terminal'],
  mcp_servers: ['github', 'sentry'],
  plugins: ['linear'],
  fs_reach: { read: ['${self}', '${shared}'], write: ['${self}'] },
};
const soulMd =
  '# Engineer\n\nI write working code. That is the primary output.\n\nI read error messages fully before responding.\n';
describe('renderCharacterSheet', () => {
  it('puts the personality id and name in the identity heading', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toMatch(/^# engineer — Engineer$/m);
  });
  it('renders the description as the role tagline', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('Terse, code-first agent that writes working code immediately.');
  });
  it('renders the first SOUL.md paragraph as role prose and stops there', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('I write working code. That is the primary output.');
    expect(sheet).not.toContain('I read error messages fully before responding.');
  });
  it('renders model and provider routing', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('claude-sonnet-4-6');
    expect(sheet).toContain('anthropic');
  });
  it('renders the memory scope', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toMatch(/Memory scope.*personality:engineer/i);
  });
  it('lists every tool in the toolset', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('read_file');
    expect(sheet).toContain('write_file');
    expect(sheet).toContain('terminal');
  });
  it('renders mcp servers, plugins, and fs_reach when present', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('github');
    expect(sheet).toContain('sentry');
    expect(sheet).toContain('linear');
    expect(sheet).toContain('${self}');
    expect(sheet).toContain('${shared}');
  });
  it('shows explicit none/default states when optional fields are absent', () => {
    const minimal = { id: 'plain', name: 'Plain' };
    const sheet = renderCharacterSheet(minimal, '# Plain\n\nA plain personality.\n');
    // Absent routing/reach must read as a deliberate default, not a blank.
    expect(sheet).toContain('Model: (engine default)');
    expect(sheet).toContain('Provider: (engine default)');
    expect(sheet).toMatch(/## Toolset\n- \(none\)/);
    expect(sheet).toMatch(/## MCP servers\n- \(none\)/);
    expect(sheet).toMatch(/## Plugins\n- \(none\)/);
    expect(sheet).toMatch(/## Filesystem reach\n- \(default/);
  });
  it('falls back gracefully when SOUL.md is empty', () => {
    const sheet = renderCharacterSheet(fullConfig, '');
    expect(sheet).toMatch(/^# engineer — Engineer$/m);
    expect(sheet).not.toContain('undefined');
  });
  it('renders capabilities when set', () => {
    const config = { ...fullConfig, capabilities: ['triage', 'cost-sensitive'] };
    const sheet = renderCharacterSheet(config, soulMd);
    expect(sheet).toContain('## Capabilities');
    expect(sheet).toContain('- triage');
    expect(sheet).toContain('- cost-sensitive');
  });
  it('renders (none) when capabilities are absent', () => {
    const minimal = { id: 'plain', name: 'Plain' };
    const sheet = renderCharacterSheet(minimal, '# Plain\n\nA plain personality.\n');
    expect(sheet).toContain('## Capabilities');
    expect(sheet).toMatch(/## Capabilities\n- \(none\)/);
  });
});
