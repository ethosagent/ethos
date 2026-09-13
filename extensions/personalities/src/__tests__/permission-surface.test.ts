// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${CWD}` tokens in config.yaml, resolved at AgentLoop construction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { renderCharacterSheet } from '../character-sheet';
import {
  type CharacterSheetMcpExport,
  diffPermissionSurface,
  formatPermissionDiff,
  type PermissionDirection,
  permissionSurface,
} from '../permission-surface';
import { SHEET_PARITY_CASES } from './sheet-parity-cases';

// P-T3 / P-D11 — the permission surface is the one extraction the character
// sheet's permission sections render from AND the permission diff classifies.

describe('sheet parity — rendering from permissionSurface left the sheet byte-identical', () => {
  const fixtures = join(import.meta.dirname, '__fixtures__', 'sheet-parity');
  for (const c of SHEET_PARITY_CASES) {
    it(`renders ${c.name} exactly as before the move`, () => {
      const before = readFileSync(join(fixtures, `${c.name}.md`), 'utf8');
      const after = renderCharacterSheet(
        c.config,
        c.soulMd,
        undefined,
        undefined,
        c.scriptCallable ? { callable: c.scriptCallable } : undefined,
        undefined,
        undefined,
        undefined,
        c.mcpExport,
      );
      expect(after).toBe(before);
    });
  }
});

const base: PersonalityConfig = {
  id: 'agent',
  name: 'Agent',
  toolset: ['read_file'],
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  fs_reach: { read: ['/data/'], write: ['/data/out/', '/tmp/'] },
  safety: { network: { allow: ['api.github.com'] } },
  budgetCapUsd: 1,
};

const exportScope = (over: Partial<CharacterSheetMcpExport> = {}): CharacterSheetMcpExport => ({
  enabled: true,
  allowed: ['read_file'],
  dropped: [],
  memory: 'none',
  sessions: false,
  auth: 'localhost',
  ...over,
});

interface Side {
  config: PersonalityConfig;
  scope?: CharacterSheetMcpExport;
}

interface ClassificationCase {
  name: string;
  before: Side;
  after: Side;
  field: string;
  direction: PermissionDirection;
  /** The direction when before/after are swapped; omit for `changes` (symmetric). */
  reverse?: PermissionDirection;
}

const gated = (over: Partial<NonNullable<PersonalityConfig['outbound_policy']>> = {}) => ({
  ...base,
  outbound_policy: { approve_before_send: true, ...over },
});

const CASES: ClassificationCase[] = [
  {
    name: 'an added network host',
    before: { config: base },
    after: { config: { ...base, safety: { network: { allow: ['api.github.com', 'x.com'] } } } },
    field: 'safety.network.allow',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'a removed write path',
    before: { config: base },
    after: { config: { ...base, fs_reach: { read: ['/data/'], write: ['/data/out/'] } } },
    field: 'fs_reach.write',
    direction: 'narrows',
    reverse: 'widens',
  },
  {
    name: 'an added read path',
    before: { config: base },
    after: { config: { ...base, fs_reach: { ...base.fs_reach, read: ['/data/', '/etc/'] } } },
    field: 'fs_reach.read',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'an added workdir',
    before: { config: base },
    after: { config: { ...base, fs_reach: { ...base.fs_reach, workdir: '/srv/project' } } },
    field: 'fs_reach.workdir',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'an added tool',
    before: { config: base },
    after: { config: { ...base, toolset: ['read_file', 'terminal'] } },
    field: 'toolset',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'no toolset at all → a declared toolset',
    before: { config: { ...base, toolset: undefined } },
    after: { config: base },
    field: 'toolset',
    direction: 'narrows',
    reverse: 'widens',
  },
  {
    name: 'an added plugin',
    before: { config: base },
    after: { config: { ...base, plugins: ['brand-identity'] } },
    field: 'plugins',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'an added MCP server',
    before: { config: base },
    after: { config: { ...base, mcp_servers: ['github'] } },
    field: 'mcp_servers',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'the host allowlist removed (open internet)',
    before: { config: base },
    after: { config: { ...base, safety: {} } },
    field: 'safety.network.allow',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'an added network deny rule',
    before: { config: base },
    after: {
      config: { ...base, safety: { network: { allow: ['api.github.com'], deny: ['evil.test'] } } },
    },
    field: 'safety.network.deny',
    direction: 'narrows',
    reverse: 'widens',
  },
  {
    name: 'allow_private_urls turned on',
    before: { config: base },
    after: {
      config: {
        ...base,
        safety: { network: { allow: ['api.github.com'], allow_private_urls: true } },
      },
    },
    field: 'safety.network.allow_private_urls',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'a raised budgetCapUsd',
    before: { config: base },
    after: { config: { ...base, budgetCapUsd: 5 } },
    field: 'budgetCapUsd',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'budgetCapUsd removed (no cap)',
    before: { config: base },
    after: { config: { ...base, budgetCapUsd: undefined } },
    field: 'budgetCapUsd',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'approve_before_send true → false',
    before: { config: gated() },
    after: { config: gated({ approve_before_send: false }) },
    field: 'outbound_policy.approve_before_send',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'a platform removed from channels',
    before: { config: gated({ channels: ['telegram', 'slack'] }) },
    after: { config: gated({ channels: ['telegram'] }) },
    field: 'outbound_policy.channels',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'every platform → an explicit channel list',
    before: { config: gated() },
    after: { config: gated({ channels: ['telegram'] }) },
    field: 'outbound_policy.channels',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'mcp_export enabled',
    before: { config: base, scope: exportScope({ enabled: false, allowed: [] }) },
    after: { config: { ...base, mcp_export: { enabled: true } }, scope: exportScope() },
    field: 'mcp_export.enabled',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'mcp_export enabled with no resolved slice',
    before: { config: base },
    after: { config: { ...base, mcp_export: { enabled: true } } },
    field: 'mcp_export.enabled',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'a tool added to expose_tools',
    before: { config: base, scope: exportScope() },
    after: { config: base, scope: exportScope({ allowed: ['read_file', 'web_search'] }) },
    field: 'mcp_export.expose_tools',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'expose_memory raised',
    before: { config: base, scope: exportScope({ memory: 'scoped' }) },
    after: { config: base, scope: exportScope({ memory: 'full' }) },
    field: 'mcp_export.expose_memory',
    direction: 'widens',
    reverse: 'narrows',
  },
  {
    name: 'expose_sessions turned on',
    before: { config: base, scope: exportScope() },
    after: { config: base, scope: exportScope({ sessions: true }) },
    field: 'mcp_export.expose_sessions',
    direction: 'widens',
    reverse: 'narrows',
  },
  // ── changes: no honest direction ──────────────────────────────────────────
  {
    name: 'a model change',
    before: { config: base },
    after: { config: { ...base, model: 'claude-opus-4' } },
    field: 'model',
    direction: 'changes',
  },
  {
    name: 'a provider change',
    before: { config: base },
    after: { config: { ...base, provider: 'openrouter' } },
    field: 'provider',
    direction: 'changes',
  },
  {
    name: 'default write scope → a declared write list',
    before: { config: { ...base, fs_reach: { read: ['/data/'] } } },
    after: { config: base },
    field: 'fs_reach.write',
    direction: 'changes',
  },
  {
    name: 'the advisory reviewer swapped',
    before: { config: gated({ approver_personality: 'editor' }) },
    after: { config: gated({ approver_personality: 'critic' }) },
    field: 'outbound_policy.approver_personality',
    direction: 'changes',
  },
  {
    name: 'export auth localhost → bearer',
    before: { config: base, scope: exportScope() },
    after: { config: base, scope: exportScope({ auth: 'bearer' }) },
    field: 'mcp_export.auth',
    direction: 'changes',
  },
  {
    name: 'an exported declaration changed with no resolved slice',
    before: { config: { ...base, mcp_export: { enabled: true, expose_sessions: false } } },
    after: { config: { ...base, mcp_export: { enabled: true, expose_sessions: true } } },
    field: 'mcp_export',
    direction: 'changes',
  },
];

function classify(before: Side, after: Side) {
  return diffPermissionSurface(
    permissionSurface(before.config, before.scope),
    permissionSurface(after.config, after.scope),
  );
}

describe('diffPermissionSurface — classification table (P-D11, X-D8)', () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.direction}`, () => {
      const diff = classify(c.before, c.after);
      const row = diff.changes.find((change) => change.field === c.field);
      expect(row?.direction).toBe(c.direction);
      expect(diff.widens).toBe(diff.changes.some((change) => change.direction === 'widens'));
    });
    const reverse = c.reverse ?? (c.direction === 'changes' ? 'changes' : undefined);
    if (reverse) {
      it(`${c.name}, reversed → ${reverse}`, () => {
        const row = classify(c.after, c.before).changes.find((change) => change.field === c.field);
        expect(row?.direction).toBe(reverse);
      });
    }
  }

  it('reports no change for identical surfaces', () => {
    const diff = classify({ config: base }, { config: { ...base } });
    expect(diff).toEqual({ changes: [], widens: false });
  });

  it('does not diff outbound keys that are inert while ungated', () => {
    const diff = classify(
      { config: gated({ approve_before_send: false, channels: ['telegram'] }) },
      { config: gated({ approve_before_send: false }) },
    );
    expect(diff.changes).toEqual([]);
  });

  it('does not diff export keys that are inert while not exported', () => {
    const diff = classify(
      { config: { ...base, mcp_export: { enabled: false, expose_sessions: false } } },
      { config: { ...base, mcp_export: { enabled: false, expose_sessions: true } } },
    );
    expect(diff.changes).toEqual([]);
  });

  it('flags a first-workdir move as a ${CWD} rebind when a list reads ${CWD}', () => {
    const diff = classify(
      { config: { ...base, fs_reach: { read: ['${CWD}'], write: ['/x/'], workdir: '/a' } } },
      { config: { ...base, fs_reach: { read: ['${CWD}'], write: ['/x/'], workdir: '/b' } } },
    );
    expect(diff.changes.map((change) => [change.field, change.direction, change.detail])).toEqual([
      ['fs_reach.workdir', 'narrows', '- /a'],
      ['fs_reach.workdir', 'widens', '+ /b'],
      ['fs_reach.workdir', 'changes', '${CWD} rebinds: /a → /b'],
    ]);
  });

  it('does not diff a dropped export tool — it grants nothing', () => {
    const diff = classify(
      { config: base, scope: exportScope() },
      { config: base, scope: exportScope({ dropped: ['terminal'] }) },
    );
    expect(diff.changes).toEqual([]);
  });
});

describe('formatPermissionDiff', () => {
  it('marks widening rows and counts each direction', () => {
    const diff = classify(
      { config: base },
      { config: { ...base, toolset: ['read_file', 'terminal'], model: 'claude-opus-4' } },
    );
    expect(formatPermissionDiff(diff, 'a', 'b')).toBe(
      [
        'Permission changes: a → b — 1 widen, 0 narrow, 1 other',
        '  + WIDENS   toolset: + terminal',
        '  ~ changes  model: claude-sonnet-4-6 → claude-opus-4',
      ].join('\n'),
    );
  });

  it('says so when nothing changed', () => {
    expect(formatPermissionDiff({ changes: [], widens: false }, 'a', 'b')).toBe(
      'No permission changes: a → b',
    );
  });
});
