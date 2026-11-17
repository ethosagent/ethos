import {
  DECISIONS_API_KEY_REF,
  describeDecisionSiteDowngrade,
  type EthosConfig,
  ethosDir,
  resolveDecisionsConfig,
} from '@ethosagent/config';
import type { CharacterSheetDecisionSite } from '@ethosagent/personalities';
import type { PersonalityConfig, SecretsResolver } from '@ethosagent/types';
import {
  buildExecutionPosture,
  type ContainerizedDetectionInput,
  resolveCharacterSheetDecisions,
} from '@ethosagent/wiring';
import { c } from './doctor-shared';

/**
 * The decision layer as `ethos doctor` reports it (plan decision-provider-jev
 * §7 / D7 / C4; plan decision-provider-personality §8): which provider and
 * which HOST data is sent to, then — per personality that declares a
 * `decisions` block — which sites run and why a site runs less than it asked
 * for. Each personality row is `resolveCharacterSheetDecisions`
 * (packages/wiring/src/decision-diagnostics.ts), the function the character
 * sheet renders `## Decisions` from, so doctor and the sheet cannot disagree.
 *
 * Personalities with no `decisions` block are not listed. With no
 * `decisions.provider` and no personality declaring one, the text form prints
 * nothing (today's behaviour).
 *
 * Known limitations, stated rather than implied:
 * - An invalid site mode in a personality's config.yaml (PD12) is NOT
 *   reported: the personality loader (`buildDecisionsConfig` in
 *   extensions/personalities/src/config-builders.ts) drops it silently, so the site
 *   reads as undeclared (`off`) here and on the character sheet.
 */
export interface DecisionLayerReport {
  configured: boolean;
  provider?: string;
  /** `new URL(decisions.baseUrl).host` — where request bodies go. */
  host?: string;
  model?: string;
  /** The vault ref the API key is read from, and whether a value is stored there. */
  apiKeyRef?: string;
  apiKeyPresent?: boolean;
  /** One row per personality that declares a `decisions` block, sorted by id. */
  personalities: DecisionPersonalityReport[];
  /** The ⚠ lines, uncoloured, in the order the text form prints them. */
  warnings: string[];
}

export interface DecisionPersonalityReport {
  id: string;
  /** The personality's `decisions.provider`, verbatim. */
  provider?: string;
  /** The operator configured that provider on this machine. */
  configured: boolean;
  sites: CharacterSheetDecisionSite[];
}

/** One site as a doctor row shows it: `injection shadow`, R6's sentence, or `x shadow → off`. */
function decisionSiteText(s: CharacterSheetDecisionSite): string {
  if (s.reason === 'threshold-missing') {
    return `${s.site} ${describeDecisionSiteDowngrade(s.missingThresholds)}`;
  }
  if (s.effective !== s.requested) return `${s.site} ${s.requested} → ${s.effective}`;
  return `${s.site} ${s.requested}`;
}

export async function checkDecisionLayer(
  config: EthosConfig | null,
  secrets: Pick<SecretsResolver, 'get'>,
  personalities: readonly PersonalityConfig[] = [],
): Promise<DecisionLayerReport> {
  const warnings: string[] = [];
  const rows: DecisionPersonalityReport[] = [];
  const globalProvider = config?.decisions?.provider;
  for (const p of [...personalities].sort((a, b) => a.id.localeCompare(b.id))) {
    const d = await resolveCharacterSheetDecisions(p, config, secrets);
    if (!d) continue;
    const sites = [...d.sites];
    rows.push({
      id: p.id,
      ...(d.provider !== undefined ? { provider: d.provider } : {}),
      configured: d.configured,
      sites,
    });
    const enabled = sites.filter((s) => s.requested !== 'off').map((s) => s.site);
    if (d.provider !== undefined && !d.configured) {
      warnings.push(
        `decisions: ${p.id} names decision model "${d.provider}", but ~/.ethos/config.yaml ` +
          (globalProvider ? `configures "${globalProvider}"` : 'has no decisions.provider') +
          ' — its sites run off.',
      );
    } else if (d.provider === undefined && enabled.length > 0) {
      warnings.push(
        `decisions: ${p.id} enables ${enabled.join(', ')} but names no decisions.provider — ` +
          'its sites run off. Add decisions.provider to its config.yaml.',
      );
    }
    const approver = sites.find((s) => s.site === 'approver');
    if (approver?.inertApprovalMode !== undefined) {
      warnings.push(
        `decisions: ${p.id} enables the approver site, but approvalMode is ` +
          `${approver.inertApprovalMode} — the approver runs only under smart.`,
      );
    }
  }

  if (!config?.decisions) {
    return { configured: false, personalities: rows, warnings };
  }
  const r = resolveDecisionsConfig(config.decisions);
  const key = await secrets.get(DECISIONS_API_KEY_REF).catch(() => null);
  const apiKeyPresent = key !== null && key.trim().length > 0;
  // plan §7: with no key stored every site runs today's path — say which ref.
  if (!apiKeyPresent) {
    warnings.push(
      `decisions: no key at vault ref ${DECISIONS_API_KEY_REF} — every site runs today's path.`,
    );
  }
  return {
    configured: true,
    provider: r.provider,
    // `buildDecisionsConfig` only keeps a baseUrl `new URL` accepts.
    host: new URL(r.baseUrl).host,
    model: r.model,
    apiKeyRef: DECISIONS_API_KEY_REF,
    apiKeyPresent,
    personalities: rows,
    warnings,
  };
}

/** The Config-section lines for {@link checkDecisionLayer}; empty when there is nothing to say. */
export function decisionLayerLines(report: DecisionLayerReport): string[] {
  if (!report.configured && report.personalities.length === 0) return [];
  const lines = [
    report.configured
      ? `     decisions:   ${report.provider} → ${report.host} · model ${report.model}`
      : '     decisions:   no decisions.provider in config.yaml',
  ];
  const width = Math.max(...report.personalities.map((p) => p.id.length)) + 1;
  for (const p of report.personalities) {
    const enabled = p.sites.filter((s) => s.requested !== 'off');
    const text =
      enabled.length > 0 ? enabled.map(decisionSiteText).join(' · ') : 'no sites enabled';
    lines.push(`                  ${`${p.id}:`.padEnd(width)} ${text}`);
  }
  for (const w of report.warnings) {
    const fix = w.startsWith('decisions: no key at vault ref')
      ? ` ${c.dim}ethos secrets set ${report.apiKeyRef} <value>${c.reset}`
      : '';
    lines.push(`  ${c.yellow}⚠${c.reset}  ${w}${fix}`);
  }
  return lines;
}

/**
 * Docker sandbox readiness: which personalities resolve to the `docker`
 * posture on this machine, and whether `execution.docker.image` gives them an
 * image to run in. Without one every exec tool those personalities call
 * refuses (`MissingDockerImageError`, extensions/execution-docker) — this is
 * the command whose job is to say so before a turn finds out.
 *
 * The posture is `buildExecutionPosture` (packages/wiring), the same resolver
 * the character sheet prints, fed the image the config owner kept (an
 * unpinned value was already dropped and reported as a parse warning). A
 * warning, not a hard failure: a deployment may carry exec-bearing built-ins
 * it never runs, and doctor's exit code is read by CI.
 */
export interface DockerSandboxReport {
  /** The pinned image, when configured. */
  image?: string;
  /** Ids whose posture is `docker`, sorted. */
  dockerPersonalities: string[];
  /** The refusal those personalities' exec tools return — set only when there is no image AND at least one docker personality. */
  missingMessage?: string;
}

export async function checkDockerSandbox(
  config: EthosConfig | null,
  personalities: readonly PersonalityConfig[],
  containerized?: ContainerizedDetectionInput,
): Promise<DockerSandboxReport> {
  const image = config?.execution?.docker?.image;
  // The same explicit `execution.containerized` signal the compose path and
  // the character sheet forward, so doctor agrees with where exec runs.
  const detect: ContainerizedDetectionInput | undefined =
    config?.execution?.containerized === true
      ? { ...containerized, containerizedConfig: true }
      : containerized;
  const ids: string[] = [];
  let missingMessage: string | undefined;
  for (const p of personalities) {
    let posture: Awaited<ReturnType<typeof buildExecutionPosture>>;
    try {
      posture = await buildExecutionPosture({
        personality: p,
        substitutionVars: { ethosHome: ethosDir(), cwd: process.cwd() },
        ...(detect ? { containerized: detect } : {}),
        sshConfigured: config?.execution?.ssh?.host !== undefined,
        dockerImage: image,
      });
    } catch {
      // A personality whose mounts cannot be derived is reported by the
      // character sheet; it costs this row, never the doctor run.
      continue;
    }
    if (posture.backend !== 'docker') continue;
    ids.push(p.id);
    missingMessage ??= posture.dockerImageMissing?.message;
  }
  ids.sort();
  return {
    ...(image ? { image } : {}),
    dockerPersonalities: ids,
    ...(missingMessage ? { missingMessage } : {}),
  };
}

/** The Config-section lines for {@link checkDockerSandbox}; empty when nothing runs in docker. */
export function dockerSandboxLines(report: DockerSandboxReport): string[] {
  if (report.dockerPersonalities.length === 0) return [];
  const who = report.dockerPersonalities.join(', ');
  if (report.image) return [`     docker:      ${report.image} ${c.dim}(${who})${c.reset}`];
  return [
    `  ${c.yellow}⚠${c.reset}  docker posture, no image configured → exec tools will fail for: ${who}`,
    `     ${c.dim}${report.missingMessage ?? ''}${c.reset}`,
  ];
}
