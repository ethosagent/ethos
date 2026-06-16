import type { ExecutionBackend, HookRegistry, PersonalityConfig, Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createProcessTools } from './index';

export interface ProcessToolsComposeOpts {
  hookRegistry?: HookRegistry;
  backend?: ExecutionBackend;
  personality?: PersonalityConfig;
}

export interface ProcessToolsCompose {
  tools: Tool[];
}

export function compose(ctx: WiringContext, opts?: ProcessToolsComposeOpts): ProcessToolsCompose {
  return {
    tools: createProcessTools(ctx.dataDir, {
      hookRegistry: opts?.hookRegistry,
      backend: opts?.backend,
      personality: opts?.personality,
    }),
  };
}
