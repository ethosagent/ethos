import type { PersonalityRegistry, Skill, Storage, Tool, ToolRegistry } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createPersonalityDesignTools, type ModelCatalogEntry } from './index';

export interface PersonalityDesignToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: {
    toolRegistry: ToolRegistry;
    storage: Storage;
    modelCatalog: ModelCatalogEntry[];
    skills: Skill[];
    personalityRegistry: PersonalityRegistry;
  },
): PersonalityDesignToolsCompose {
  return {
    tools: createPersonalityDesignTools({
      toolRegistry: deps.toolRegistry,
      storage: deps.storage,
      modelCatalog: deps.modelCatalog,
      skills: deps.skills,
      personalityRegistry: deps.personalityRegistry,
    }),
  };
}
