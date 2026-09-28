import type { CronScheduler } from '@ethosagent/cron';
import type { Tool, WiringContext } from '@ethosagent/types';
import { type CronToolOptions, createCronTool } from './index';

export interface CronToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: { scheduler: CronScheduler } & CronToolOptions,
): CronToolsCompose {
  const { scheduler, ...opts } = deps;
  return { tools: createCronTool(scheduler, opts) };
}
