// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${self}` / `${shared}` tokens in config.yaml — they resolve at
// AgentLoop construction, not in the registry, so the renderer sees them verbatim.
import type { ExecutionPosture, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { renderCharacterSheet } from '../character-sheet';

// The character sheet is the SOUL.md "tight character sheet" promise made
// into a real artifact — one Markdown screen that says what a personality
// is, what it has, and what it can reach. `renderCharacterSheet` is the
// single generator both the CLI (`ethos personality show`) and the Web
// Personalities tab render.

const fullConfig: PersonalityConfig = {
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

  it('renders an estimated system-prompt token count (§2)', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('## Prompt size');
    expect(sheet).toMatch(/Estimated system-prompt tokens: ~\d+/);
  });

  it('renders dreaming off when unset', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('Dreaming: off');
  });

  it('renders dreaming on when enabled', () => {
    const config = { ...fullConfig, dreaming: { enable: true, idleMinutes: 60, maxPerDay: 1 } };
    const sheet = renderCharacterSheet(config, soulMd);
    expect(sheet).toContain('Dreaming: on');
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
    const minimal: PersonalityConfig = { id: 'plain', name: 'Plain' };
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
    const minimal: PersonalityConfig = { id: 'plain', name: 'Plain' };
    const sheet = renderCharacterSheet(minimal, '# Plain\n\nA plain personality.\n');
    expect(sheet).toContain('## Capabilities');
    expect(sheet).toMatch(/## Capabilities\n- \(none\)/);
  });

  it('renders the Living Soul section for a sectioned soul', () => {
    const livingSoulMd =
      '# Core\nI am the engineer. This never changes.\n\n# Expression\nI write terse, code-first replies.\n\n# Learning Log\n- 2026-06-17T00:00:00.000Z · expr-rev-1 · "tightened tone" · evidence: sessions:3 · prev: expr-rev-1\n';
    const sheet = renderCharacterSheet(fullConfig, livingSoulMd);
    expect(sheet).toContain('## Living Soul');
    expect(sheet).toContain('I write terse, code-first replies.');
    expect(sheet).toContain('expr-rev-1');
    expect(sheet).toContain('tightened tone');
  });

  it('renders no Living Soul section for a flat soul', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).not.toContain('## Living Soul');
  });
});

describe('renderCharacterSheet — ## Execution section', () => {
  function dockerPosture(extra: Partial<ExecutionPosture> = {}): ExecutionPosture {
    return {
      backend: 'docker',
      networkMode: 'none',
      memoryMb: 256,
      containerized: false,
      mounts: [
        { hostPath: '/Users/me/proj', containerPath: '/Users/me/proj', mode: 'rw' },
        { hostPath: '/etc/ethos/skills', containerPath: '/etc/ethos/skills', mode: 'ro' },
      ],
      scratchPaths: ['/tmp'],
      ...extra,
    };
  }

  it('omits the Execution section when no posture is passed', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).not.toContain('## Execution');
  });

  it('renders posture, network, memory cap, mounts, scratch, and blast radius', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'linux',
    });
    expect(sheet).toContain('## Execution');
    expect(sheet).toMatch(/- Posture:\s+docker \(sandboxed\)/);
    expect(sheet).toMatch(/- Network:\s+none/);
    expect(sheet).toMatch(/- Memory cap: 256 MB/);
    expect(sheet).toContain('/Users/me/proj (rw)');
    expect(sheet).toContain('/etc/ethos/skills (ro)');
    expect(sheet).toContain('/tmp (ephemeral scratch, wiped on exit)');
    // A7 — the rw mount roots are the write blast radius.
    expect(sheet).toMatch(/Write blast radius \(A7\): \/Users\/me\/proj/);
  });

  it('relabels ssh posture as remote-host trust, not mount-confined (A3)', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: { ...dockerPosture(), backend: 'ssh', mounts: [], scratchPaths: [] },
      platform: 'linux',
    });
    expect(sheet).toMatch(/ssh = remote-host trust — NOT mount-confined/);
  });

  it('renders the containerized note for a containerized local posture', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: {
        backend: 'local',
        networkMode: 'none',
        memoryMb: 256,
        containerized: true,
        mounts: [],
        scratchPaths: [],
      },
      platform: 'linux',
    });
    expect(sheet).toMatch(/Posture:\s+containerized \(local\)/);
    expect(sheet).toMatch(/isolation boundary = the Ethos container/);
    expect(sheet).toMatch(/enforced app-layer only/);
  });

  it('renders the #7 macOS caveat for docker on darwin', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'darwin',
    });
    expect(sheet).toMatch(/macOS \(#7\)/);
    expect(sheet).toMatch(/NOT a hard security boundary/);
  });

  it('does NOT render the macOS caveat on linux', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'linux',
    });
    expect(sheet).not.toMatch(/macOS \(#7\)/);
  });

  it('renders the A1 docker-absent decision with a consent option', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture({
        dockerAbsent: { blocked: true, canInstall: true, canConsentLocal: true },
      }),
      platform: 'linux',
    });
    expect(sheet).toMatch(/Docker required but not running \(A1\)/);
    expect(sheet).toMatch(/run un-sandboxed on host \(explicit consent required\)/);
  });

  it('renders the A1 state without a consent option when local is forbidden', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture({
        dockerAbsent: {
          blocked: true,
          canInstall: true,
          canConsentLocal: false,
          consentForbiddenReason: 'the constitution forbids the local posture',
        },
      }),
      platform: 'linux',
    });
    expect(sheet).toMatch(/Un-sandboxed consent withheld: the constitution forbids/);
    expect(sheet).not.toMatch(/explicit consent required/);
  });

  it('renders the honest local host-fallback posture (F1) instead of claiming Docker', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: {
        backend: 'local',
        networkMode: 'none',
        memoryMb: 256,
        containerized: false,
        mounts: [],
        scratchPaths: [],
        hostFallback: { reason: 'docker-disabled' },
      },
      platform: 'linux',
    });
    // The posture line must say it runs un-sandboxed on the host, never "docker".
    expect(sheet).toMatch(/Posture:\s+local \(un-sandboxed — runs on host; Docker unavailable\)/);
    expect(sheet).toMatch(/Host fallback \(F1\)/);
    expect(sheet).toMatch(/Docker execution is disabled in this process/);
    expect(sheet).not.toMatch(/docker \(sandboxed\)/);
  });

  it('renders the honest local host-fallback posture (P2) instead of claiming ssh', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: {
        backend: 'local',
        networkMode: 'none',
        memoryMb: 256,
        containerized: false,
        mounts: [],
        scratchPaths: [],
        hostFallback: { reason: 'ssh-unavailable' },
      },
      platform: 'linux',
    });
    // Never claims "ssh (remote host)" — says it runs un-sandboxed on the host.
    expect(sheet).toMatch(
      /Posture:\s+local \(un-sandboxed — runs on host; ssh backend unavailable\)/,
    );
    expect(sheet).toMatch(/Host fallback \(P2\)/);
    expect(sheet).toMatch(/no ssh execution backend is wired in this build/);
    expect(sheet).not.toMatch(/ssh \(remote host\)/);
  });

  it('marks a forbidden-ssh posture as refusing exec (P2), never silent host', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: { ...dockerPosture(), backend: 'ssh', mounts: [], scratchPaths: [] },
      platform: 'linux',
    });
    expect(sheet).toMatch(/Note \(P2\)/);
    expect(sheet).toMatch(/execution tools refuse \(not_available\)/);
  });

  it('renders a constitution clamp notice for the active personality', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'linux',
      enforcement: {
        clamps: [
          { personalityId: 'engineer', field: 'budgetCapUsd', declared: 100, clamped: 10 },
          { personalityId: 'other', field: 'budgetCapUsd', declared: 5, clamped: 1 },
        ],
      },
    });
    expect(sheet).toMatch(/Constitution clamp: budgetCapUsd 100 → 10/);
    // A clamp for a DIFFERENT personality must not leak onto this sheet.
    expect(sheet).not.toMatch(/budgetCapUsd 5 → 1/);
  });
});
