import { basename } from 'node:path';
import { AgentBridge } from '@ethosagent/agent-bridge';
import { render } from 'ink';
import { createElement } from 'react';
import { App } from './components/App';

export { AgentBridge } from '@ethosagent/agent-bridge';
export async function runTUI(loop, opts) {
  const bridge = new AgentBridge(loop);
  const sessionKey = `cli:${basename(process.cwd())}`;
  const { waitUntilExit } = render(
    createElement(App, {
      bridge,
      model: opts.model,
      initialPersonality: opts.personality,
      initialSessionKey: sessionKey,
      initialVerbose: opts.verbose ?? false,
      initialSkin: opts.skin,
      rebuildLoop: opts.rebuildLoop,
      inventory: opts.inventory,
      version: opts.version,
    }),
  );
  await waitUntilExit();
}
