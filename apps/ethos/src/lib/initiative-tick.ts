// The `initiative-tick` system cron job (plan Task 5.5; a system-task handler, so it lives in lib/): one `InitiativeRuntime.tick`.
//
// The job carries no prompt and no toolset. Nothing is built until `initiatives.db` exists, so an
// install that never saved an initiative spends $0 and opens no extra loop. After that the loop is
// built once per process and reused; it is not disposed while the host runs (limitation: the host
// has no hook for it, so it is released at process exit).
import { join } from 'node:path';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import type { CreateAgentLoopResult } from '@ethosagent/wiring';
import { createAgentLoop, getStorage } from '../wiring';

let runtime: Promise<CreateAgentLoopResult> | undefined;

export async function runInitiativeTickOnce(config: EthosConfig): Promise<string> {
  if (!runtime) {
    if (!(await getStorage().exists(join(ethosDir(), 'initiatives.db')))) {
      return 'No initiatives saved; nothing to do';
    }
    runtime = createAgentLoop(config);
    runtime.catch(() => {
      runtime = undefined; // a failed build retries on the next tick; the caller below reports it
    });
  }
  const { initiativeRuntime } = await runtime;
  const report = await initiativeRuntime.tick(new Date());
  if (report.skipped) return `Initiative tick skipped (${report.skipped})`;
  return `Initiative tick: ${report.ran.length} run(s), ${report.paused.length} paused, ${report.resumed.length} resumed`;
}
