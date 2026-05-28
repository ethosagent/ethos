import { AcpServer } from '@ethosagent/acp-server';
import { createSessionStore } from '@ethosagent/wiring';
import { ethosDir } from '../config';
import { createAgentLoop } from '../wiring';
export async function runAcp(config) {
    const dir = ethosDir();
    const { loop } = await createAgentLoop(config);
    // separate connection for fork_session / resume_session reads and writes
    const session = createSessionStore({ dataDir: dir });
    const server = new AcpServer({ runner: loop, session });
    server.start();
    // keep the process alive — readline drives everything from here
    await new Promise(() => { });
}
