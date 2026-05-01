// ethos mcp — MCP server lifecycle and client configuration
//
// Subcommands:
//   ethos mcp serve            Start the MCP stdio server
//   ethos mcp install <client> Write Ethos into a client's MCP config
//   ethos mcp init             Show quick-start snippet for a client
//   ethos mcp doctor           Verify MCP server is reachable and functional
//   ethos mcp inspect          List tools, resources, and prompts

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClientAdapter } from '@ethosagent/mcp-server';
import {
  claudeDesktop,
  continueClient,
  cursor,
  EthosMcpServer,
  logger as mcpLogger,
  opencode,
  zed,
} from '@ethosagent/mcp-server';
import { ethosDir, readConfig } from '../config';
import { createAgentLoop, getStorage } from '../wiring';

const CLIENTS: ClientAdapter[] = [claudeDesktop, cursor, opencode, continueClient, zed];

const USAGE = `Usage: ethos mcp <subcommand> [options]

Subcommands:
  serve            Start the Ethos MCP server over stdio
  install <client> Install Ethos into a supported MCP client's config
  init [client]    Print quick-start config snippet
  doctor           Verify server configuration
  inspect          List available tools, resources, and prompts

Supported clients: ${CLIENTS.map((c) => c.name).join(', ')}`;

export async function runMcp(argv: string[]): Promise<void> {
  const sub = argv[0] ?? '';

  switch (sub) {
    case 'serve':
      return runServe();
    case 'install':
      return runInstall(argv.slice(1));
    case 'init':
      return runInit(argv[1]);
    case 'doctor':
      return runDoctor();
    case 'inspect':
      return runInspect();
    default: {
      if (sub && sub !== '--help' && sub !== '-h') {
        console.error(`Unknown subcommand: ${sub}\n`);
      }
      console.log(USAGE);
    }
  }
}

async function runServe(): Promise<void> {
  const storage = getStorage();
  const config = await readConfig(storage);
  const loop = await createAgentLoop(config);
  const server = new EthosMcpServer({ loop, dataDir: ethosDir(), logger: mcpLogger });
  await server.start();
  // Keep process alive — the stdio transport handles shutdown
}

async function runInstall(argv: string[]): Promise<void> {
  const clientName = argv[0];
  if (!clientName) {
    console.log(`Specify a client to install into:\n\n  ethos mcp install <client>\n`);
    console.log(`Supported: ${CLIENTS.map((c) => c.name).join(', ')}`);
    return;
  }

  const adapter = CLIENTS.find((c) => c.name === clientName);
  if (!adapter) {
    console.error(`Unknown client: ${clientName}`);
    console.error(`Supported: ${CLIENTS.map((c) => c.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const configPath = adapter.configPath();
  const existing = adapter.readConfig(configPath);
  const entry = { command: process.execPath, args: [process.argv[1] ?? 'ethos', 'mcp', 'serve'] };
  const updated = adapter.injectEntry(existing, entry);
  const serialised = adapter.serialise(updated);

  if (!existsSync(dirname(configPath))) {
    mkdirSync(dirname(configPath), { recursive: true });
  }
  writeFileSync(configPath, serialised, 'utf8');
  console.log(`✓ Installed Ethos MCP server into ${adapter.displayName}`);
  console.log(`  Config: ${configPath}`);
}

function runInit(clientName?: string): void {
  const adapter = clientName ? CLIENTS.find((c) => c.name === clientName) : null;

  if (clientName && !adapter) {
    console.error(`Unknown client: ${clientName}`);
    console.error(`Supported: ${CLIENTS.map((c) => c.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const execPath = process.execPath;
  const scriptPath = process.argv[1] ?? 'ethos';

  if (!adapter || adapter.name === 'claude-desktop' || adapter.name === 'cursor') {
    console.log(`Add to claude_desktop_config.json / mcp.json:\n`);
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            ethos: { command: execPath, args: [scriptPath, 'mcp', 'serve'] },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (adapter.name === 'opencode') {
    console.log(`Add to ~/.config/opencode/config.json:\n`);
    console.log(
      JSON.stringify(
        {
          mcp: {
            servers: {
              ethos: { type: 'local', command: [execPath, scriptPath, 'mcp', 'serve'] },
            },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (adapter.name === 'zed') {
    console.log(`Add to Zed settings.json:\n`);
    console.log(
      JSON.stringify(
        {
          context_servers: {
            ethos: { command: { path: execPath, args: [scriptPath, 'mcp', 'serve'] } },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (adapter.name === 'continue') {
    console.log(`Add to ~/.continue/config.json:\n`);
    console.log(
      JSON.stringify(
        {
          mcpServers: [{ name: 'ethos', command: execPath, args: [scriptPath, 'mcp', 'serve'] }],
        },
        null,
        2,
      ),
    );
    return;
  }
}

function runDoctor(): void {
  console.log('Ethos MCP doctor\n');

  const execPath = process.execPath;
  const scriptPath = process.argv[1] ?? 'ethos';
  console.log(`  Node:   ${execPath}`);
  console.log(`  Script: ${scriptPath}`);
  console.log(`  Command: ${execPath} ${scriptPath} mcp serve`);
  console.log();

  for (const adapter of CLIENTS) {
    const path = adapter.configPath();
    const installed = existsSync(path);
    const mark = installed ? '✓' : ' ';
    console.log(`  [${mark}] ${adapter.displayName.padEnd(20)} ${path}`);
  }

  console.log();
  console.log('Run "ethos mcp install <client>" to configure a client.');
}

function runInspect(): void {
  console.log('Tools:\n');
  console.log('  ask_personality     Run a prompt through a specific personality');
  console.log('  list_personalities  List all available personalities');
  console.log('  search_memory       Search MEMORY.md and USER.md');

  console.log('\nResources:\n');
  console.log('  ethos://memory/MEMORY.md          Agent memory');
  console.log('  ethos://memory/USER.md             User context');
  console.log('  ethos://sessions/recent            Recent sessions');
  console.log('  ethos://personalities/<id>/ETHOS.md  Personality identity');

  console.log('\nPrompts:\n');
  console.log('  code_review          Structured code review');
  console.log('  research_topic       Deep research with citations');
  console.log('  reflect_on_decision  Coaching reflection');
  console.log('  debug_failure        Evidence-first failure investigation');
}
