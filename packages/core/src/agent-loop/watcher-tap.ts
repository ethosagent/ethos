import type { AgentSafety, WatcherEvent } from '@ethosagent/types';
import type { HaltDecision, WatcherTap } from './turn-context';

export function createWatcherTap(safety: AgentSafety): WatcherTap {
  const watcher = safety.watcher;
  watcher?.resetTurn();

  let haltState: HaltDecision | null = null;

  return {
    observe: (event: WatcherEvent): void => {
      if (!watcher) return;
      const d = watcher.observe(event);
      if (d.action !== 'allow') haltState = d;
    },
    getHalt: (): HaltDecision | null => haltState,
  };
}
