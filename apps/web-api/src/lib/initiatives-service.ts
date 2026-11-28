import type { Storage } from '@ethosagent/types';
import type { InitiativeEnablement } from '@ethosagent/wiring';
import type { CreateWebApiOptions } from '../index';
import { InitiativesService } from '../services/initiatives.service';

/**
 * The initiative engine's web service. `enablement` is the loop's `InitiativeEnablement`: a
 * settings save that flips `enabled` calls `reload(personalityId)` so the change shows in chat
 * now, not on the runtime's 5-minute tick. Absent, the tick catches up. Limitation: `ethos serve`
 * does not yet thread it from `CreateAgentLoopResult`, and `bindAgentLoop` does not install it.
 */
export function buildInitiativesService(
  opts: Pick<CreateWebApiOptions, 'dataDir' | 'personalities' | 'initiativeEnablement'>,
  storage: Storage,
): InitiativesService {
  const enablement: Pick<InitiativeEnablement, 'reload'> | undefined = opts.initiativeEnablement;
  return new InitiativesService({
    storage,
    dataDir: opts.dataDir,
    personalities: opts.personalities,
    enablement: () => enablement,
  });
}
