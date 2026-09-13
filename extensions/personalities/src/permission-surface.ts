import type {
  ModelTierConfig,
  PersonalityConfig,
  PersonalityMcpExportConfig,
} from '@ethosagent/types';
import { normalizeWorkdir } from './workdirs';

// The permission surface — what a personality may reach, as STRUCTURED data
// (P-D11, X-D8 in plan/phases/trust-before-reach.md). Two consumers read the
// same extraction:
//
//  - the character sheet (`renderCharacterSheet`, ./character-sheet.ts) renders
//    its Toolset, MCP servers, MCP export, Plugins and Filesystem reach
//    sections and its `Publishing:` line from the section renderers below;
//  - `diffPermissionSurface` classifies each change as widening, narrowing or
//    neither, which a text diff of two sheets cannot do.
//
// One extraction is what keeps the sheet and the diff from disagreeing. The
// parity snapshot (`__tests__/permission-surface.test.ts`) pins that moving the
// sheet onto this module left its text byte-identical.

/**
 * The resolved `mcp_export` slice, as the sheet needs to PRINT it.
 *
 * Structurally the print-relevant half of `McpExportScope` — the return of
 * `resolveMcpExportScope` (`packages/wiring/src/mcp-export.ts`, M-T2), which is
 * the one owner of the resolution and the thing `PersonalityExportServer`
 * (`apps/mcp-server/src/export-server.ts`) actually runs a turn under. Declared
 * here rather than imported because `packages/wiring` sits ABOVE `extensions/`
 * in the layer model (ARCHITECTURE.md §II, enforced by
 * `scripts/check-architecture.mjs`), so this package cannot reach it; an
 * `McpExportScope` satisfies this interface as is, and the caller passes the
 * resolved value in.
 */
export interface CharacterSheetMcpExport {
  /** `mcp_export.enabled === true`, literally — fail-closed (M-D4). */
  enabled: boolean;
  /** Tools an exported turn may use: the declaration ∩ the personality's reach. */
  allowed: readonly string[];
  /** Tools the declaration named that are OUTSIDE that reach — printed, not dropped silently. */
  dropped: readonly string[];
  /** `expose_memory`, defaulted to `'none'`. */
  memory: 'none' | 'scoped' | 'full';
  /** `expose_sessions`, defaulted to `false`. */
  sessions: boolean;
  /** `auth`, defaulted to `'localhost'`. */
  auth: 'localhost' | 'bearer';
}

/**
 * Everything a personality may reach, one field per permission row. Values are
 * the DECLARED config (substitutions such as `${CWD}` unresolved), plus the
 * resolved `mcp_export` slice when the caller could compute one.
 */
export interface PermissionSurface {
  personalityId: string;
  /**
   * `toolset`. `declared: false` means no toolset.yaml at all, which is NOT an
   * empty allowlist: `DefaultToolRegistry.toDefinitions(undefined)`
   * (packages/core/src/tool-registry.ts) lets every registered built-in tool
   * through. `tools` is `[]` in that case, which is what the sheet prints.
   */
  toolset: { declared: boolean; tools: readonly string[] };
  /**
   * `fs_reach`. An EMPTY `read` or `write` list declares nothing and falls back
   * to that list's default scope, independently of the other —
   * `deriveFsReachPaths` (packages/core/src/fs-reach.ts). `workdirs` is
   * normalized the way the sheet has always printed it (`normalizeWorkdir`).
   */
  fsReach: { read: readonly string[]; write: readonly string[]; workdirs: readonly string[] };
  /** `safety.network`. An empty `allow` is the open public internet over the safeFetch floor. */
  network: { allow: readonly string[]; deny: readonly string[]; allowPrivateUrls: boolean };
  plugins: readonly string[];
  mcpServers: readonly string[];
  /** Declared model and provider, `(engine default)` when unset. */
  routing: { model: string; provider: string };
  /** Per-session spending cap; `undefined` = no cap. */
  budgetCapUsd: number | undefined;
  /** `outbound_policy`. `channels: 'all'` = no `channels` key = every platform. */
  publishing: {
    gated: boolean;
    channels: readonly string[] | 'all';
    approver: string | undefined;
  };
  /**
   * `mcp_export`. `enabled` reads the resolved slice when there is one, and
   * otherwise `mcp_export.enabled === true` literally — the predicate
   * `resolveMcpExportScope` fails closed on. `scope` is never computed here.
   */
  mcpExport: {
    enabled: boolean;
    declaration: PersonalityMcpExportConfig | undefined;
    scope: CharacterSheetMcpExport | undefined;
  };
}

const ENGINE_DEFAULT = '(engine default)';

/** A tier map printed as one comparable line, keys in a fixed order. */
function modelLabel(model: string | ModelTierConfig | undefined): string {
  if (model === undefined) return ENGINE_DEFAULT;
  if (typeof model === 'string') return model;
  const tiers = (['trivial', 'default', 'deep', 'dreaming'] as const)
    .filter((tier) => model[tier] !== undefined)
    .map((tier) => `${tier}: ${model[tier]}`);
  return tiers.length > 0 ? tiers.join(', ') : ENGINE_DEFAULT;
}

/**
 * Extract a personality's permission surface.
 *
 * `mcpExport` is the RESOLVED export slice from `resolveMcpExportScope`, passed
 * in exactly as `renderCharacterSheet` takes it: this package cannot import
 * `packages/wiring`, so it never resolves one itself. Absent → the surface
 * carries the declaration only, and the diff says it could not compute a
 * direction for the slice rather than guessing one.
 */
export function permissionSurface(
  config: PersonalityConfig,
  mcpExport?: CharacterSheetMcpExport,
): PermissionSurface {
  const reach = config.fs_reach;
  const network = config.safety?.network;
  const policy = config.outbound_policy;
  return {
    personalityId: config.id,
    toolset: { declared: config.toolset !== undefined, tools: config.toolset ?? [] },
    fsReach: {
      read: reach?.read ?? [],
      write: reach?.write ?? [],
      workdirs: normalizeWorkdir(reach?.workdir),
    },
    network: {
      allow: network?.allow ?? [],
      deny: network?.deny ?? [],
      allowPrivateUrls: network?.allow_private_urls === true,
    },
    plugins: config.plugins ?? [],
    mcpServers: config.mcp_servers ?? [],
    routing: { model: modelLabel(config.model), provider: config.provider ?? ENGINE_DEFAULT },
    budgetCapUsd: config.budgetCapUsd,
    publishing: {
      gated: policy?.approve_before_send === true,
      channels: policy?.channels && policy.channels.length > 0 ? policy.channels : 'all',
      approver: policy?.approver_personality,
    },
    mcpExport: {
      enabled: mcpExport ? mcpExport.enabled : config.mcp_export?.enabled === true,
      declaration: config.mcp_export,
      scope: mcpExport,
    },
  };
}

// ---------------------------------------------------------------------------
// Sheet section renderers — the character sheet's permission sections, read
// off the surface. Each returns lines; `renderCharacterSheet` owns the order
// and the blank lines between sections.
// ---------------------------------------------------------------------------

export function bulletList(items: readonly string[], emptyLabel: string): string[] {
  if (items.length === 0) return [`- ${emptyLabel}`];
  return items.map((item) => `- ${item}`);
}

/** `## Toolset`: the heading, the count, and one bullet per tool. */
export function toolsetLines(surface: PermissionSurface): string[] {
  const tools = surface.toolset.tools;
  const lines = ['## Toolset'];
  if (tools.length > 0) lines.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}:`);
  lines.push(...bulletList(tools, '(none)'));
  return lines;
}

export function mcpServersLines(surface: PermissionSurface): string[] {
  return ['## MCP servers', ...bulletList(surface.mcpServers, '(none)')];
}

export function pluginsLines(surface: PermissionSurface): string[] {
  return ['## Plugins', ...bulletList(surface.plugins, '(none)')];
}

/** `## Filesystem reach`: declared read/write, or the default scope, then workdirs. */
export function filesystemReachLines(surface: PermissionSurface): string[] {
  const { read, write, workdirs } = surface.fsReach;
  const lines = ['## Filesystem reach'];
  if (read.length > 0 || write.length > 0) {
    lines.push(`- Read: ${read.length > 0 ? read.join(', ') : '(none)'}`);
    lines.push(`- Write: ${write.length > 0 ? write.join(', ') : '(none)'}`);
  } else {
    lines.push(
      '- (default — read: own directory, ~/.ethos/skills/, working directory; write: own directory, working directory)',
    );
  }
  // `, `-joined, the same form `renderConfigYaml` writes and `parseCsv` reads
  // back; the label pluralises the way the web sheet's does.
  if (workdirs.length > 0) {
    lines.push(`- Workdir${workdirs.length === 1 ? '' : 's'}: ${workdirs.join(', ')}`);
  }
  return lines;
}

/**
 * The egress paths the outbound-approval gate does NOT cover (O-D10). Printed
 * on every gated sheet rather than left implied: covering MCP tools and
 * `a2a_send` would mean classifying arbitrary third-party tools, and a sheet
 * that said nothing would read as blanket coverage.
 */
const PUBLISHING_NOT_COVERED = 'not covered: MCP tools, a2a_send';

/**
 * The `Publishing:` line — what `outbound_policy` does for THIS personality,
 * and what it does not.
 *
 * This function only RENDERS. The gate it describes is in `executeSendMessage`
 * (extensions/tools-messaging/src/index.ts); the queue, the immutable
 * revisions and the content binding are `SQLiteOutboxStore` / `OutboxService`
 * in `@ethosagent/outbox`; the `channels` list it reads was validated at load
 * by `parseOutboundChannels` (./index.ts).
 */
export function publishingLine(surface: PermissionSurface): string {
  const policy = surface.publishing;
  if (!policy.gated) {
    return 'Publishing: not gated — send_message goes out as soon as the agent calls it';
  }
  const where =
    policy.channels === 'all' ? 'on every platform' : `on ${policy.channels.join(', ')}`;
  const reviewer = policy.approver
    ? `reviewer: ${policy.approver}`
    : 'reviewer: none — a human approves directly';
  return `Publishing: approval required ${where} · ${reviewer} · ${PUBLISHING_NOT_COVERED}`;
}

/**
 * M-D15 — the two bounds the export does NOT have, printed on every exported
 * sheet rather than left implied, the same way `PUBLISHING_NOT_COVERED` is.
 *
 * What each clause names as the actual bound:
 *  - `budgetCapUsd` per session key — `AgentLoop.getPersonalityBudgetCap`
 *    (packages/core/src/agent-loop.ts), applied to the turn the export runs;
 *  - one in-flight call per client — the `_inFlight` set in
 *    `PersonalityExportServer` (apps/mcp-server/src/export-server.ts);
 *  - revocation — `SqliteApiKeyStore.findByHash` filters `revoked_at IS NULL`,
 *    and `createMcpClientAuthenticator` re-verifies on every call;
 *  - loopback — `serveMcpHttp` (apps/mcp-server/src/http-session.ts)
 *    refuses a non-loopback bind outright.
 * None of them is a request-rate limit and none of them is transport
 * encryption, which is why both lines are stated as limitations.
 */
const MCP_EXPORT_LIMITATIONS: readonly string[] = [
  '- No rate limit: an admitted client may call as often as it likes. What bounds the cost is ' +
    'budgetCapUsd per session key, one in-flight call per client, and revoking the key.',
  '- Loopback only, no TLS: HTTP binds 127.0.0.1 and the traffic is not encrypted. A remote ' +
    "caller needs the operator's own TLS-terminating proxy.",
];

/** `expose_memory` in prose — what the exported turn can actually reach. */
function mcpExportMemoryLine(memory: CharacterSheetMcpExport['memory'], id: string): string {
  if (memory === 'none') return '- Memory: none — no prefetch, no memory tools';
  if (memory === 'full') return `- Memory: full — personality:${id}, memory_write exposed`;
  return `- Memory: scoped — personality:${id}, read-only`;
}

/**
 * Render the `## MCP export` block — whether another app can ask THIS
 * personality anything, and on exactly what terms.
 *
 * Without a resolved slice the block says the slice was not resolved rather
 * than guessing one, because the defaults that would produce a guess live in
 * `resolveMcpExportScope` and a second copy here would be a second thing to
 * drift.
 *
 * Dropped tools are PRINTED. An operator who names `terminal` in
 * `expose_tools` and never sees it again should learn from the sheet that the
 * personality never had it — `expose_tools` can only ever remove reach.
 */
export function mcpExportSection(surface: PermissionSurface): string[] {
  const id = surface.personalityId;
  const { enabled, scope } = surface.mcpExport;
  const lines: string[] = ['## MCP export'];

  if (!enabled) {
    lines.push('- Status: not exported — no other app can ask this personality anything.');
    lines.push(
      `- To export it: set mcp_export.enabled: true in config.yaml, then run \`ethos mcp serve --personality ${id}\`.`,
    );
    return lines;
  }

  lines.push(`- Status: exported — \`ethos mcp serve --personality ${id}\``);

  if (!scope) {
    lines.push(
      "- Resolved slice: not available in this rendering. Which tools the caller's turn may use, " +
        'and the memory, conversation and auth terms, are resolved at serve time against the tools ' +
        `registered then; \`ethos mcp serve --personality ${id}\` prints them on start.`,
    );
    return lines;
  }

  lines.push(
    scope.allowed.length > 0
      ? `- Caller's turn may use: ${scope.allowed.join(', ')}`
      : "- Caller's turn may use: (none) — conversation only",
  );
  for (const tool of scope.dropped) {
    lines.push(`    - ${tool} — dropped, not in this personality's reach`);
  }
  lines.push(mcpExportMemoryLine(scope.memory, id));
  lines.push(
    scope.sessions
      ? `- Conversations: exposed — this client's own only, under mcp:${id}:<client>:`
      : '- Conversations: not exposed',
  );
  lines.push(
    scope.auth === 'bearer'
      ? `- Auth: bearer — an sk-ethos- key scoped mcp:${id}, over stdio or HTTP`
      : '- Auth: localhost — stdio only; the boundary is whoever can spawn ethos as this OS user',
  );
  lines.push(...MCP_EXPORT_LIMITATIONS);
  return lines;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/**
 * - `widens`  — the personality can reach, spend or send more, or with fewer gates.
 * - `narrows` — the reverse.
 * - `changes` — different, with no honest direction (a model swap, a default
 *   scope traded for a declared one). Each such case is commented where it is
 *   classified.
 */
export type PermissionDirection = 'widens' | 'narrows' | 'changes';

/** One changed permission row. */
export interface PermissionChange {
  /** The character-sheet heading the row belongs under. */
  section:
    | 'Toolset'
    | 'Filesystem reach'
    | 'Network'
    | 'Plugins'
    | 'MCP servers'
    | 'Routing'
    | 'Budget'
    | 'Publishing'
    | 'MCP export';
  /** The config key that changed, as written in config.yaml (`toolset` for toolset.yaml). */
  field: string;
  direction: PermissionDirection;
  /** One line: `+ web_search`, `- /tmp/`, `true → false`. */
  detail: string;
}

export interface PermissionDiff {
  /** In sheet order; empty when nothing a permission row covers changed. */
  changes: PermissionChange[];
  /** True when at least one change widens. */
  widens: boolean;
}

type Section = PermissionChange['section'];

/** Member-by-member rows for a list whose entries each grant (or, reversed, gate) something. */
function membershipRows(
  section: Section,
  field: string,
  before: readonly string[],
  after: readonly string[],
  added: PermissionDirection = 'widens',
  removed: PermissionDirection = 'narrows',
): PermissionChange[] {
  const rows: PermissionChange[] = [];
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const item of before) {
    if (!afterSet.has(item)) rows.push({ section, field, direction: removed, detail: `- ${item}` });
  }
  for (const item of after) {
    if (!beforeSet.has(item)) rows.push({ section, field, direction: added, detail: `+ ${item}` });
  }
  return rows;
}

function listLabel(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.join(', ') : empty;
}

function toolsetRows(before: PermissionSurface, after: PermissionSurface): PermissionChange[] {
  const b = before.toolset;
  const a = after.toolset;
  if (b.declared && a.declared) return membershipRows('Toolset', 'toolset', b.tools, a.tools);
  if (b.declared === a.declared) return [];
  // An undeclared toolset is every registered built-in tool, and a declared
  // one can only name a subset of those (an unregistered name grants nothing),
  // so these two transitions have a direction.
  return [
    b.declared
      ? {
          section: 'Toolset',
          field: 'toolset',
          direction: 'widens',
          detail: `${b.tools.length} declared → no toolset (every registered built-in tool)`,
        }
      : {
          section: 'Toolset',
          field: 'toolset',
          direction: 'narrows',
          detail: `no toolset (every registered built-in tool) → ${a.tools.length} declared`,
        },
  ];
}

const DEFAULT_SCOPE = '(default scope)';

function fsListRows(
  field: 'fs_reach.read' | 'fs_reach.write',
  before: readonly string[],
  after: readonly string[],
): PermissionChange[] {
  if (before.length > 0 && after.length > 0) {
    return membershipRows('Filesystem reach', field, before, after);
  }
  if (before.length === after.length) return [];
  // Default scope ↔ declared prefixes: AMBIGUOUS. The default (own directory,
  // skills, working directory — `deriveFsReachPaths`) and a declared list are
  // unresolved prefixes; neither contains the other in general, so no
  // direction is claimed.
  return [
    {
      section: 'Filesystem reach',
      field,
      direction: 'changes',
      detail: `${listLabel(before, DEFAULT_SCOPE)} → ${listLabel(after, DEFAULT_SCOPE)}`,
    },
  ];
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal config token, not a template.
const CWD_TOKEN = '${CWD}';

function fsReachRows(before: PermissionSurface, after: PermissionSurface): PermissionChange[] {
  const b = before.fsReach;
  const a = after.fsReach;
  const rows = [
    ...fsListRows('fs_reach.read', b.read, a.read),
    ...fsListRows('fs_reach.write', b.write, a.write),
    // Every declared workdir is a reachable root: the first joins both derived
    // lists (`deriveFsReachPaths`), every entry is its own Documents root.
    ...membershipRows('Filesystem reach', 'fs_reach.workdir', b.workdirs, a.workdirs),
  ];
  // The FIRST workdir is also what `${CWD}` means (`deriveFsReachPaths`). When
  // it moves, every list that reads `${CWD}` — a defaulted list always does —
  // now points somewhere else: AMBIGUOUS, the new place is neither inside nor
  // outside the old one in general.
  const firstBefore = b.workdirs[0];
  const firstAfter = a.workdirs[0];
  const readsCwd = (s: PermissionSurface['fsReach']) =>
    s.read.length === 0 ||
    s.write.length === 0 ||
    [...s.read, ...s.write].some((path) => path.includes(CWD_TOKEN));
  if (firstBefore !== firstAfter && (readsCwd(b) || readsCwd(a))) {
    rows.push({
      section: 'Filesystem reach',
      field: 'fs_reach.workdir',
      direction: 'changes',
      detail: `${CWD_TOKEN} rebinds: ${firstBefore ?? '(process cwd)'} → ${firstAfter ?? '(process cwd)'}`,
    });
  }
  return rows;
}

function networkRows(before: PermissionSurface, after: PermissionSurface): PermissionChange[] {
  const b = before.network;
  const a = after.network;
  const rows: PermissionChange[] = [];
  const field = 'safety.network.allow';
  if (b.allow.length > 0 && a.allow.length > 0) {
    rows.push(...membershipRows('Network', field, b.allow, a.allow));
  } else if (b.allow.length === 0 && a.allow.length > 0) {
    // Open public internet → an allowlist.
    rows.push({
      section: 'Network',
      field,
      direction: 'narrows',
      detail: `open public internet → allowlist: ${a.allow.join(', ')}`,
    });
  } else if (b.allow.length > 0 && a.allow.length === 0) {
    rows.push({
      section: 'Network',
      field,
      direction: 'widens',
      detail: `allowlist: ${b.allow.join(', ')} → open public internet`,
    });
  }
  // A deny rule gates; adding one narrows.
  rows.push(
    ...membershipRows('Network', 'safety.network.deny', b.deny, a.deny, 'narrows', 'widens'),
  );
  if (b.allowPrivateUrls !== a.allowPrivateUrls) {
    rows.push({
      section: 'Network',
      field: 'safety.network.allow_private_urls',
      direction: a.allowPrivateUrls ? 'widens' : 'narrows',
      detail: `${b.allowPrivateUrls} → ${a.allowPrivateUrls}`,
    });
  }
  return rows;
}

function routingRows(before: PermissionSurface, after: PermissionSurface): PermissionChange[] {
  // AMBIGUOUS by nature: a different model or provider is neither more nor
  // less reach. What it costs is `budgetCapUsd`'s row, not this one.
  const rows: PermissionChange[] = [];
  for (const key of ['model', 'provider'] as const) {
    const b = before.routing[key];
    const a = after.routing[key];
    if (b !== a) {
      rows.push({ section: 'Routing', field: key, direction: 'changes', detail: `${b} → ${a}` });
    }
  }
  return rows;
}

function budgetRows(before: PermissionSurface, after: PermissionSurface): PermissionChange[] {
  const b = before.budgetCapUsd;
  const a = after.budgetCapUsd;
  if (b === a) return [];
  const label = (v: number | undefined) => (v === undefined ? 'no cap' : `$${v}`);
  // No cap is unbounded spend, so removing a cap widens and adding one narrows.
  const widens = a === undefined || (b !== undefined && a > b);
  return [
    {
      section: 'Budget',
      field: 'budgetCapUsd',
      direction: widens ? 'widens' : 'narrows',
      detail: `${label(b)} → ${label(a)}`,
    },
  ];
}

function publishingRows(before: PermissionSurface, after: PermissionSurface): PermissionChange[] {
  const b = before.publishing;
  const a = after.publishing;
  const section = 'Publishing';
  if (b.gated !== a.gated) {
    // Ungating means fewer sends wait for a human.
    return [
      {
        section,
        field: 'outbound_policy.approve_before_send',
        direction: a.gated ? 'narrows' : 'widens',
        detail: `${b.gated} → ${a.gated}`,
      },
    ];
  }
  // Both ungated: `channels` and the reviewer are inert at runtime
  // (`executeSendMessage` ignores them) and the `Publishing:` line does not
  // print them, so neither does the diff.
  if (!a.gated) return [];

  const rows: PermissionChange[] = [];
  const field = 'outbound_policy.channels';
  if (b.channels !== 'all' && a.channels !== 'all') {
    // A platform in `channels` is GATED; removing one lets its sends through.
    rows.push(...membershipRows(section, field, b.channels, a.channels, 'narrows', 'widens'));
  } else if (b.channels !== a.channels) {
    // `'all'` gates every platform, so any explicit list gates no more than it.
    rows.push({
      section,
      field,
      direction: a.channels === 'all' ? 'narrows' : 'widens',
      detail:
        a.channels === 'all'
          ? `${listLabel(b.channels as readonly string[], '')} → every platform`
          : `every platform → ${a.channels.join(', ')}`,
    });
  }
  if (b.approver !== a.approver) {
    // AMBIGUOUS: the reviewer is advisory (a PASS/FAIL receipt) and a human
    // still decides either way, so adding, removing or swapping one gates
    // neither more nor fewer sends.
    rows.push({
      section,
      field: 'outbound_policy.approver_personality',
      direction: 'changes',
      detail: `${b.approver ?? '(none)'} → ${a.approver ?? '(none)'}`,
    });
  }
  return rows;
}

const MEMORY_RANK: Record<CharacterSheetMcpExport['memory'], number> = {
  none: 0,
  scoped: 1,
  full: 2,
};

/** Key-order-independent form of a flat declaration, for an equality check. */
function declarationKey(declaration: PersonalityMcpExportConfig | undefined): string {
  if (!declaration) return '';
  return JSON.stringify(declaration, Object.keys(declaration).sort());
}

function sliceSummary(scope: CharacterSheetMcpExport | undefined): string {
  if (!scope) return 'slice not resolved';
  return `tools: ${listLabel(scope.allowed, '(none)')}; memory ${scope.memory}; conversations ${
    scope.sessions ? 'exposed' : 'not exposed'
  }; auth ${scope.auth}`;
}

function mcpExportRows(before: PermissionSurface, after: PermissionSurface): PermissionChange[] {
  const b = before.mcpExport;
  const a = after.mcpExport;
  const section = 'MCP export';
  if (b.enabled !== a.enabled) {
    return [
      a.enabled
        ? {
            section,
            field: 'mcp_export.enabled',
            direction: 'widens',
            detail: `not exported → exported (${sliceSummary(a.scope)})`,
          }
        : {
            section,
            field: 'mcp_export.enabled',
            direction: 'narrows',
            detail: `exported (${sliceSummary(b.scope)}) → not exported`,
          },
    ];
  }
  // Both not exported: the resolver grants nothing whatever the other keys
  // say, and the sheet prints none of them.
  if (!a.enabled) return [];

  if (!b.scope || !a.scope) {
    if (declarationKey(b.declaration) === declarationKey(a.declaration)) return [];
    // AMBIGUOUS here, not in general: the direction of the slice is computed
    // over RESOLVED scopes, and the defaults that resolve a declaration live in
    // `resolveMcpExportScope`, which this package cannot call.
    return [
      {
        section,
        field: 'mcp_export',
        direction: 'changes',
        detail:
          'declaration changed; slice not resolved in this rendering — direction not computed',
      },
    ];
  }

  // `dropped` is deliberately not diffed: a dropped tool grants nothing.
  const rows = membershipRows(section, 'mcp_export.expose_tools', b.scope.allowed, a.scope.allowed);
  if (b.scope.memory !== a.scope.memory) {
    rows.push({
      section,
      field: 'mcp_export.expose_memory',
      direction: MEMORY_RANK[a.scope.memory] > MEMORY_RANK[b.scope.memory] ? 'widens' : 'narrows',
      detail: `${b.scope.memory} → ${a.scope.memory}`,
    });
  }
  if (b.scope.sessions !== a.scope.sessions) {
    rows.push({
      section,
      field: 'mcp_export.expose_sessions',
      direction: a.scope.sessions ? 'widens' : 'narrows',
      detail: `${b.scope.sessions} → ${a.scope.sessions}`,
    });
  }
  if (b.scope.auth !== a.scope.auth) {
    // AMBIGUOUS: `bearer` adds a transport (loopback HTTP) that `localhost`
    // refuses, but also requires a scoped, revocable key that `localhost`
    // never asks for — more reachable and more authenticated at once.
    rows.push({
      section,
      field: 'mcp_export.auth',
      direction: 'changes',
      detail: `${b.scope.auth} → ${a.scope.auth}`,
    });
  }
  return rows;
}

/**
 * Classify every permission change between two surfaces (P-D11).
 *
 * Computed over the structured rows, never the sheet text. Rows come out in
 * sheet order: Toolset, MCP servers, MCP export, Plugins, Filesystem reach,
 * Publishing, then the rows the sheet has no section for (Network, Routing,
 * Budget).
 */
export function diffPermissionSurface(
  before: PermissionSurface,
  after: PermissionSurface,
): PermissionDiff {
  const changes = [
    ...toolsetRows(before, after),
    ...membershipRows('MCP servers', 'mcp_servers', before.mcpServers, after.mcpServers),
    ...mcpExportRows(before, after),
    ...membershipRows('Plugins', 'plugins', before.plugins, after.plugins),
    ...fsReachRows(before, after),
    ...publishingRows(before, after),
    ...networkRows(before, after),
    ...routingRows(before, after),
    ...budgetRows(before, after),
  ];
  return { changes, widens: changes.some((change) => change.direction === 'widens') };
}

const DIRECTION_MARK: Record<PermissionDirection, string> = {
  widens: '+ WIDENS ',
  narrows: '- narrows',
  changes: '~ changes',
};

/**
 * Plain-text rendering of a diff: a count line, then one line per change with
 * widening rows marked `+ WIDENS`.
 */
export function formatPermissionDiff(diff: PermissionDiff, labelA: string, labelB: string): string {
  if (diff.changes.length === 0) return `No permission changes: ${labelA} → ${labelB}`;
  const count = (direction: PermissionDirection) =>
    diff.changes.filter((change) => change.direction === direction).length;
  const lines = [
    `Permission changes: ${labelA} → ${labelB} — ${count('widens')} widen, ${count(
      'narrows',
    )} narrow, ${count('changes')} other`,
  ];
  for (const change of diff.changes) {
    lines.push(`  ${DIRECTION_MARK[change.direction]}  ${change.field}: ${change.detail}`);
  }
  return lines.join('\n');
}
