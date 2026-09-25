import { join } from 'node:path';
import { AcpServer } from '@ethosagent/acp-server';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import { ConsoleLogger } from '@ethosagent/logger';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { createLazyProvider, createSessionStore } from '@ethosagent/wiring';
import { createAcpMcpWiring } from '../lib/acp-mcp-wiring';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { wireTerminalApprovalGate } from '../terminal-approval';
import { createAgentLoop, createLLM, getStorage } from '../wiring';

export async function runAcp(config: EthosConfig): Promise<void> {
  const dir = ethosDir();
  const runtime = await createAgentLoop(config);
  const { loop, mcpManager, activePersonality } = runtime;
  // Fail closed: this server does not send ACP's `session/request_permission`
  // (its dialect is `new_session` / `prompt` / `$/stream`, with no outbound
  // request/response correlation), so nobody can be asked and a flagged call
  // is refused. The mark also lets the terminal guard hand command
  // substitution to this gate, which refuses it with the same reason.
  wireTerminalApprovalGate(loop.hooks, {
    personalities: runtime.personalities,
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
    ...(runtime.approverDecision ? { decision: runtime.approverDecision } : {}),
    executionPostureFor: runtime.executionPostureFor,
    coordinator: null,
    nonInteractive: 'the ACP server cannot show an approval prompt to its client',
  });
  // separate connection for fork_session / resume_session reads and writes
  const session = createSessionStore({ dataDir: dir });
  const personalities = await createPersonalityRegistry({
    storage: getStorage(),
    userPersonalitiesDir: dir,
  });
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  const server = new AcpServer({
    runner: loop,
    session,
    // ConsoleLogger writes warnings to stderr; stdout is the JSON-RPC channel.
    logger: new ConsoleLogger({}, config.logs?.level),
    ...createAcpMcpWiring({
      mcpManager,
      personalities,
      defaultPersonalityId: activePersonality.id,
    }),
  });
  server.start();

  // `ethos acp` has no exit of its own — the editor that spawned it closes the
  // pipe or signals. Release on the signal (memoised, so a second Ctrl-C does
  // not start a second teardown) so the loop's stores and the separate session
  // handle opened above close instead of dying with the process.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      await releaseCommandRuntime(runtime, {
        label: 'acp agent loop',
        also: [['acp sessions.db', async () => session.close()]],
      });
      process.exit(0);
    })();
    return shuttingDown;
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // keep the process alive — readline drives everything from here
  await new Promise(() => {});
}
