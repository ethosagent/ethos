import { FileContextInjector } from './file-context-injector';
import { GetSkillTool } from './get-skill-tool';
import { MemoryGuidanceInjector } from './memory-guidance-injector';
import { SkillsInjector } from './skills-injector';
import { UniversalScanner } from './universal-scanner';

export { BUNDLED_SKILL_IDS, bundledSkillsSource } from './bundled';
export { checkSkillEnv, defaultWhich } from './env-resolver';
export { FileContextInjector } from './file-context-injector';
export { GetSkillTool } from './get-skill-tool';
export { filterSkill, setEnvResolverOptions, warnMissingAllowList } from './ingest-filter';
export { MemoryGuidanceInjector } from './memory-guidance-injector';
export { PlatformFormattingInjector } from './platform-formatting-injector';
export { sanitize } from './prompt-injection-guard';
export { applySubstitutions, parseSkillFrontmatter, shouldInject } from './skill-compat';
export { SkillsInjector } from './skills-injector';
export { SkillsLibrary } from './skills-library';
export { externalSources, UniversalScanner } from './universal-scanner';
/**
 * Creates the standard set of context injectors and skill tools.
 *
 * The returned `tools` array must be registered in the ToolRegistry before
 * creating the AgentLoop. The injector and tools share one UniversalScanner
 * so the mtime cache is reused across inject + get_skill calls.
 */
export function createInjectors(personalities, config = {}) {
  const scanner = new UniversalScanner({
    extraSources: config.extraSources,
    trustedFirstPartySources: config.trustedFirstPartySources,
  });
  const skillsInjector = new SkillsInjector(personalities, {
    globalSkillsDir: config.globalSkillsDir,
    onSkip: config.onSkillSkip,
    scanner,
  });
  const fileContext = new FileContextInjector({
    personalities,
    ...(config.hooks ? { hooks: config.hooks } : {}),
  });
  // `skillsInjector` is surfaced concretely (not just inside `injectors`) so
  // read-only surfaces can call `resolveSkills()` without re-deriving the
  // scanner + filter wiring.
  return {
    injectors: [skillsInjector, fileContext, new MemoryGuidanceInjector()],
    tools: [new GetSkillTool(scanner)],
    skillsInjector,
    scanner,
  };
}
