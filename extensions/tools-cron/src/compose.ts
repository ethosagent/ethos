import type { CronScheduler } from '@ethosagent/cron';
import type { Tool, WiringContext } from '@ethosagent/types';
import { createCronTool } from './index';

export interface CronToolsCompose {
  tools: Tool[];
}

export function compose(_ctx: WiringContext, deps: { scheduler: CronScheduler }): CronToolsCompose {
  return { tools: createCronTool(deps.scheduler) };
}
