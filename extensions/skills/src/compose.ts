import type {
  ContextInjector,
  HookRegistry,
  Logger,
  PersonalityConfig,
  PersonalityRegistry,
  Skill,
  Tool,
} from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import {
  bundledSkillsSource,
  createInjectors,
  PlatformFormattingInjector,
  type ScanSource,
  type SkillsInjector,
  UniversalScanner,
} from './index';

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
  _ctx: WiringContext,
  deps: {
    personalities: PersonalityRegistry;
    activePerson: PersonalityConfig;
    hooks: HookRegistry;
    platformPrompts: Map<string, string>;
    log: Logger;
  },
): Promise<SkillsCompose> {
  const { personalities, hooks, platformPrompts, log } = deps;

  const codingBundleSource = bundledSkillsSource();
  const skillPool = await new UniversalScanner({
    trustedFirstPartySources: [codingBundleSource],
  }).scan();

  const { injectors, tools, skillsInjector, scanner } = createInjectors(personalities, {
    onSkillSkip: (skillId, reason) => log.info(`skill ${skillId} skipped: ${reason}`),
    trustedFirstPartySources: [codingBundleSource],
    hooks,
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
