// The `initiative-tick` system cron job (plan Task 5.5; a system-task handler, so it lives in lib/): one `InitiativeRuntime.tick`.
//
// The job carries no prompt and no toolset. Nothing is built until `initiatives.db` exists, so an
// install that never saved an initiative spends $0 and opens no extra loop. After that the loop is
// built once per process and reused; it is not disposed while the host runs (limitation: the host
// has no hook for it, so it is released at process exit).
import { join } from 'node:path';
import { type EthosConfig, ethosDir, hostTimeZone } from '@ethosagent/config';
import type { CreateAgentLoopResult, DigestNotify } from '@ethosagent/wiring';
import { createAgentLoop, getStorage } from '../wiring';

let runtime: Promise<CreateAgentLoopResult> | undefined;
let digestNotify: DigestNotify | undefined;

/**
 * The gateway host calls this once it has a gateway (`bindInitiativeHost`); the tick hands it to
 * the runtime, which sends the owner digest through it. A host with no gateway sends no digest.
 */
export function setInitiativeDigestNotify(notify: DigestNotify | undefined): void {
  digestNotify = notify;
}

/**
 * The zone `delivery.digestTime` is read in: the one quiet hours use (`notifications.timezone`,
 * else the host's zone; `resolveGatewayQuietHours` in commands/gateway-wiring.ts). Pinned by
 * apps/ethos/src/__tests__/initiative-tick-timezone.test.ts.
 */
export function digestTimeZone(config: Pick<EthosConfig, 'notifications'>): string {
  return config.notifications?.timezone ?? hostTimeZone();
}

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
  initiativeRuntime.setNotify(digestNotify);
  const report = await initiativeRuntime.tick(new Date(), { timeZone: digestTimeZone(config) });
  if (report.skipped) return `Initiative tick skipped (${report.skipped})`;
  return `Initiative tick: ${report.ran.length} run(s), ${report.paused.length} paused, ${report.resumed.length} resumed, ${report.digests.length} digest(s)`;
}
