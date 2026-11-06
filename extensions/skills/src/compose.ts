import { catalogSkillsRoot } from '@ethosagent/catalog';
import type {
  ContextInjector,
  HookRegistry,
  Logger,
  PersonalityConfig,
  PersonalityRegistry,
  Skill,
  Tool,
  WiringContext,
} from '@ethosagent/types';
import {
  bundledSkillsSource,
  createInjectors,
  PlatformFormattingInjector,
  type ScanSource,
  type SkillsInjector,
  UniversalScanner,
} from './index';
import { CATALOG_SOURCE_LABEL } from './ingest-filter';

export interface SkillsCompose {
  /** The bundled (first-party) skill source — reused by the scanner and MCP passthrough. */
  codingBundleSource: ScanSource;
  /** Pre-scanned skill pool keyed by qualified name. Mutable: plugin sources merge later. */
  skillPool: Map<string, Skill>;
  /** Context injectors to feed into AgentLoop (platform formatting already prepended). */
  injectors: ContextInjector[];
  /** Tools produced by createInjectors (e.g. get_skill). */
  tools: Tool[];
  /** The skills injector instance — surfaces can call resolveSkills() directly. */
  skillsInjector: SkillsInjector;
  /** The live scanner — addExtraSources() for plugin skill dirs. */
  scanner: UniversalScanner;
}

export async function compose(
  ctx: WiringContext,
  deps: {
    personalities: PersonalityRegistry;
    activePerson: PersonalityConfig;
    hooks: HookRegistry;
    platformPrompts: Map<string, string>;
    log: Logger;
    /**
     * Gap 11 — live tool-reach getter (registry-backed) for `requires.tools`
     * gating and capability-mode filtering. Lazy so tools registered after
     * skills composition (MCP, plugins) are visible.
     */
    toolNamesForPersonality?: (personality: PersonalityConfig) => Set<string>;
  },
): Promise<SkillsCompose> {
  const { personalities, hooks, platformPrompts, log, toolNamesForPersonality } = deps;

  const codingBundleSource = bundledSkillsSource();
  // Catalog skills (unified-catalog D16) live under `<dataDir>/catalog-skills/`,
  // so this source honours ETHOS_STATE_DIR (unlike the `ethos` default source).
  // Community tier, because `extraSources` always is. They are invisible to
  // every personality until allowed: `filterSkill`'s catalog rule
  // (ingest-filter.ts, pinned by __tests__/ingest-filter.test.ts).
  const catalogSource: ScanSource = {
    label: CATALOG_SOURCE_LABEL,
    dir: catalogSkillsRoot(ctx.dataDir),
  };
  const skillPool = await new UniversalScanner({
    storage: ctx.storage,
    trustedFirstPartySources: [codingBundleSource],
    extraSources: [catalogSource],
  }).scan();

  const { injectors, tools, skillsInjector, scanner } = createInjectors(personalities, {
    storage: ctx.storage,
    onSkillSkip: (skillId, reason) => log.info(`skill ${skillId} skipped: ${reason}`),
    trustedFirstPartySources: [codingBundleSource],
    extraSources: [catalogSource],
    hooks,
    ...(toolNamesForPersonality ? { toolNamesForPersonality } : {}),
  });

  injectors.unshift(new PlatformFormattingInjector(platformPrompts));

  return {
    codingBundleSource,
    skillPool,
    injectors,
    tools,
    skillsInjector,
    scanner,
  };
}
