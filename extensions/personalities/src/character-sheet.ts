import {
  type ConstitutionEnforcement,
  type ExecutionPosture,
  type PersonalityConfig,
  resolveModelDisplay,
} from '@ethosagent/types';

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
 * Optional context for the `## Execution` section. The renderer is pure: it
 * formats whatever posture the caller resolved (via the wiring posture
 * resolver) and the constitution enforcement it loaded. When `posture` is
 * absent the section is omitted entirely (e.g. surfaces that don't resolve
 * execution).
 */
export interface CharacterSheetExecution {
  posture: ExecutionPosture;
  /** Operator constitution enforcement — surfaces clamp notices for this id. */
  enforcement?: ConstitutionEnforcement;
  /**
   * Host platform exec will run on (`process.platform`). Drives the #7 macOS
   * caveat. Injectable for tests; defaults to the current platform.
   */
  platform?: NodeJS.Platform;
}

const POSTURE_LABEL: Record<ExecutionPosture['backend'], string> = {
  docker: 'docker (sandboxed)',
  local: 'local (un-sandboxed — runs in this process)',
  ssh: 'ssh (remote host)',
  none: 'none (no execution backend)',
};

/** Render the `## Execution` block. Pure — takes the resolved posture + context. */
function executionSection(config: PersonalityConfig, exec: CharacterSheetExecution): string[] {
  const { posture, enforcement } = exec;
  const platform = exec.platform ?? process.platform;
  const lines: string[] = ['## Execution'];

  const postureLabel = posture.containerized
    ? 'containerized (local)'
    : POSTURE_LABEL[posture.backend];
  lines.push(`- Posture:    ${postureLabel}`);
  lines.push(`- Network:    ${posture.networkMode}`);
  lines.push(`- Memory cap: ${posture.memoryMb} MB`);

  // Mounts + the ${CWD} blast radius (A7): the rw mount roots are the writable
  // host paths a shell escape could damage.
  if (posture.backend === 'docker') {
    if (posture.mounts.length > 0) {
      lines.push(`- Mounts (${posture.mounts.length}):`);
      for (const m of posture.mounts) {
        lines.push(`    - ${m.hostPath} (${m.mode})`);
      }
    } else {
      lines.push('- Mounts:     (default — personality directory + cwd)');
    }
    for (const scratch of posture.scratchPaths) {
      lines.push(`    - ${scratch} (ephemeral scratch, wiped on exit)`);
    }
    const rwRoots = posture.mounts.filter((m) => m.mode === 'rw').map((m) => m.hostPath);
    lines.push(
      `- Write blast radius (A7): ${
        rwRoots.length > 0 ? rwRoots.join(', ') : '(none — read-only mounts)'
      }`,
    );
  }

  // Containerized note (mirrors the honest trade in the plan).
  if (posture.containerized) {
    lines.push(
      '- Containerized: isolation boundary = the Ethos container; fs_reach + network',
      '  enforced app-layer only, shared across personalities in this process.',
    );
  }

  // ssh relabel (A3) — remote-host trust, NOT mount-confinement.
  if (posture.backend === 'ssh') {
    lines.push('- Note (A3): ssh = remote-host trust — NOT mount-confined.');
  }

  // #7 macOS caveat — docker on macOS is best-effort, not a hard boundary.
  if (posture.backend === 'docker' && platform === 'darwin') {
    lines.push(
      '- macOS (#7): boundary is best-effort via Docker Desktop’s VM —',
      '  best-effort, NOT a hard security boundary. Rootless/gVisor is deferred.',
    );
  }

  // A1 docker-absent decision state — surfaced, never a silent fallback.
  if (posture.dockerAbsent) {
    lines.push('- Docker required but not running (A1):');
    lines.push('    - Option: install/start Docker');
    if (posture.dockerAbsent.canConsentLocal) {
      lines.push('    - Option: run un-sandboxed on host (explicit consent required)');
    } else {
      lines.push(
        `    - Un-sandboxed consent withheld: ${
          posture.dockerAbsent.consentForbiddenReason ?? 'forbidden by the constitution'
        }`,
      );
    }
  }

  // Constitution clamp notices (from D1 enforcement) for THIS personality.
  const clamps = (enforcement?.clamps ?? []).filter((c) => c.personalityId === config.id);
  for (const clamp of clamps) {
    lines.push(`- Constitution clamp: ${clamp.field} ${clamp.declared} → ${clamp.clamped}`);
  }

  return lines;
}

/**
 * Render a personality's character sheet as Markdown. Pure — takes the
 * loaded config and the SOUL.md body, returns the artifact. Optional
 * fields render as explicit `(none)` / `(engine default)` states so a
 * reader never has to guess whether a blank means "unset" or "missing".
 */
export function renderCharacterSheet(
  config: PersonalityConfig,
  soulMd: string,
  execution?: CharacterSheetExecution,
): string {
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

  if (execution) {
    lines.push('');
    lines.push(...executionSection(config, execution));
  }

  return `${lines.join('\n')}\n`;
}
