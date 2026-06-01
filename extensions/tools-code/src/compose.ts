import type { DockerSandbox } from '@ethosagent/sandbox-docker';
import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createCodeTools } from './index';

export interface CodeToolsCompose {
  tools: Tool[];
}

export function compose(_ctx: WiringContext, deps: { sandbox: DockerSandbox }): CodeToolsCompose {
  return { tools: createCodeTools(deps.sandbox) };
}
