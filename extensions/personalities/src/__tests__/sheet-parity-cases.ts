// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${CWD}` tokens in config.yaml, resolved at AgentLoop construction.
import type { PersonalityConfig } from '@ethosagent/types';
import type { CharacterSheetMcpExport } from '../permission-surface';

/**
 * The representative personalities the sheet-parity snapshot pins (P-D11).
 * `__fixtures__/sheet-parity/<name>.md` holds each one's sheet as rendered by
 * `renderCharacterSheet` BEFORE its permission sections moved onto
 * `permissionSurface`; the parity test re-renders and compares byte for byte.
 */
export interface SheetParityCase {
  name: string;
  config: PersonalityConfig;
  soulMd: string;
  scriptCallable?: readonly string[];
  mcpExport?: CharacterSheetMcpExport;
}

const SOUL = '# Agent\n\nI do careful work and say what I did.\n';

export const SHEET_PARITY_CASES: readonly SheetParityCase[] = [
  {
    name: 'minimal',
    config: { id: 'minimal', name: 'Minimal' },
    soulMd: '',
  },
  {
    name: 'full-reach',
    config: {
      id: 'full-reach',
      name: 'Full Reach',
      description: 'Every permission section populated',
      toolset: ['read_file', 'write_file', 'web_search', 'run_code'],
      model: { default: 'claude-sonnet-4-6', deep: 'claude-opus-4' },
      provider: 'anthropic',
      mcp_servers: ['github', 'linear'],
      plugins: ['brand-identity'],
      budgetCapUsd: 2.5,
      fs_reach: {
        read: ['${ETHOS_HOME}/shared/', '${CWD}'],
        write: ['${CWD}/out/'],
        workdir: ['/srv/docs', '/srv/notes'],
      },
      safety: { network: { allow: ['api.github.com'], deny: ['evil.example'] } },
    },
    soulMd: SOUL,
    scriptCallable: ['read_file', 'web_search'],
  },
  {
    name: 'workdir-only',
    config: {
      id: 'workdir-only',
      name: 'Workdir Only',
      toolset: ['read_file'],
      fs_reach: { workdir: '/srv/project' },
    },
    soulMd: SOUL,
  },
  {
    name: 'outbound-gated',
    config: {
      id: 'outbound-gated',
      name: 'Outbound Gated',
      toolset: ['send_message'],
      outbound_policy: {
        approve_before_send: true,
        channels: ['telegram', 'slack'],
        approver_personality: 'brand-editor',
      },
    },
    soulMd: SOUL,
  },
  {
    name: 'outbound-every-platform',
    config: {
      id: 'outbound-every-platform',
      name: 'Outbound Every Platform',
      toolset: ['send_message'],
      outbound_policy: { approve_before_send: true },
    },
    soulMd: SOUL,
  },
  {
    name: 'mcp-export-resolved',
    config: {
      id: 'mcp-export-resolved',
      name: 'MCP Export Resolved',
      toolset: ['read_file', 'memory_read'],
      mcp_export: {
        enabled: true,
        expose_tools: ['read_file', 'terminal'],
        expose_memory: 'scoped',
        expose_sessions: true,
        auth: 'bearer',
      },
    },
    soulMd: SOUL,
    mcpExport: {
      enabled: true,
      allowed: ['memory_read', 'read_file'],
      dropped: ['terminal'],
      memory: 'scoped',
      sessions: true,
      auth: 'bearer',
    },
  },
  {
    name: 'mcp-export-unresolved',
    config: {
      id: 'mcp-export-unresolved',
      name: 'MCP Export Unresolved',
      toolset: ['read_file'],
      mcp_export: { enabled: true, expose_tools: 'all' },
    },
    soulMd: SOUL,
  },
  {
    name: 'mcp-export-empty-slice',
    config: {
      id: 'mcp-export-empty-slice',
      name: 'MCP Export Empty Slice',
      toolset: ['read_file'],
      mcp_export: { enabled: true },
    },
    soulMd: SOUL,
    mcpExport: {
      enabled: true,
      allowed: [],
      dropped: [],
      memory: 'full',
      sessions: false,
      auth: 'localhost',
    },
  },
  {
    name: 'run-code-empty-surface',
    config: {
      id: 'run-code-empty-surface',
      name: 'Run Code Empty Surface',
      toolset: ['run_code'],
      fs_reach: { read: ['/data/'] },
    },
    soulMd: SOUL,
    scriptCallable: [],
  },
];
