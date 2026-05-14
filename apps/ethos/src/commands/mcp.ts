// ethos mcp — MCP server lifecycle and client configuration
//
// Subcommands:
//   ethos mcp serve            Start the MCP stdio server
//   ethos mcp install <client> Write Ethos into a client's MCP config
//   ethos mcp init             Show quick-start snippet for a client
//   ethos mcp doctor           Verify MCP server is reachable and functional
//   ethos mcp inspect          List tools, resources, and prompts
//   ethos mcp add <name>       Add an MCP server to ~/.ethos/mcp.json
//   ethos mcp presets           List available MCP server presets

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { getPreset, MCP_PRESETS } from '@ethosagent/tools-mcp';
import type { McpServerConfig } from '@ethosagent/tools-mcp';
import { ethosDir, readConfig } from '../config';
import { createAgentLoop, getSecretsResolver, getStorage } from '../wiring';

const CLIENTS: ClientAdapter[] = [claudeDesktop, cursor, opencode, continueClient, zed];

const USAGE = `Usage: ethos mcp <subcommand> [options]

Subcommands:
  serve [options]  Start the Ethos MCP server
    --http           Use Streamable HTTP transport instead of stdio
    --port <n>       HTTP port (default: 3300, implies --http)
    --bind-public    Bind to 0.0.0.0 (required for non-loopback)
  install <client> Install Ethos into a supported MCP client's config
  init [client]    Print quick-start config snippet
  doctor           Verify server configuration
  inspect          List available tools, resources, and prompts
  add <name>       Add an MCP server to ~/.ethos/mcp.json
    --preset <name>  Use a built-in preset (see 'ethos mcp presets')
    --env KEY=val    Set environment variable (repeatable)
  presets          List available MCP server presets

Supported clients: ${CLIENTS.map((c) => c.name).join(', ')}`;

export async function runMcp(argv: string[]): Promise<void> {
  const sub = argv[0] ?? '';

  switch (sub) {
    case 'serve':
      return runServe(argv.slice(1));
    case 'install':
      return runInstall(argv.slice(1));
    case 'init':
      return runInit(argv[1]);
    case 'doctor':
      return runDoctor();
    case 'inspect':
      return runInspect();
    case 'add':
      return runAdd(argv.slice(1));
    case 'presets':
      return runPresets();
    default: {
      if (sub && sub !== '--help' && sub !== '-h') {
        console.error(`Unknown subcommand: ${sub}\n`);
      }
      console.log(USAGE);
    }
  }
}

async function runServe(argv: string[]): Promise<void> {
  let useHttp = false;
  let port = 3300;
  let bindPublic = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--http') {
      useHttp = true;
    } else if (arg === '--port') {
      useHttp = true;
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        console.error('--port requires a number');
        process.exitCode = 1;
        return;
      }
      port = Number(next);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${next}`);
        process.exitCode = 1;
        return;
      }
      i++;
    } else if (arg === '--bind-public') {
      bindPublic = true;
    }
  }

  const storage = getStorage();
  const config = await readConfig(storage, getSecretsResolver());
  if (!config) {
    // Must go to stderr — stdout must remain pure JSON-RPC
    process.stderr.write(
      JSON.stringify({ level: 'error', msg: 'No ~/.ethos/config.yaml found. Run: ethos setup' }) +
        '\n',
    );
    process.exit(1);
  }
  const loop = await createAgentLoop(config);
  const sessionStore = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
  const server = new EthosMcpServer({
    loop,
    dataDir: ethosDir(),
    logger: mcpLogger,
    sessionStore,
  });

  if (useHttp) {
    await server.serveHttp({ port, bindPublic });
    // Keep process alive — the HTTP server handles shutdown
  } else {
    await server.start();
    // Keep process alive — the stdio transport handles shutdown
  }
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

// ---------------------------------------------------------------------------
// mcp add — add an MCP server entry to ~/.ethos/mcp.json
// ---------------------------------------------------------------------------

const ADD_USAGE = `Usage: ethos mcp add <name> [options]

Options:
  --preset <name>  Use a built-in preset (see 'ethos mcp presets')
  --env KEY=val    Set environment variable (repeatable)

Without --preset, you must provide --command and optionally --args:
  --command <cmd>  Server command (e.g. 'npx')
  --args <a> ...   Command arguments (consumes remaining positional args)

Examples:
  ethos mcp add fs --preset filesystem --env ALLOWED_PATHS=/data
  ethos mcp add my-git --preset git --env GIT_REPO_PATH=/repos/myapp
  ethos mcp add custom --command npx --args -y @myorg/mcp-server`;

function parseAddArgs(argv: string[]): {
  name?: string;
  preset?: string;
  env: Record<string, string>;
  command?: string;
  args: string[];
} {
  const env: Record<string, string> = {};
  const extraArgs: string[] = [];
  let name: string | undefined;
  let preset: string | undefined;
  let command: string | undefined;
  let collectingArgs = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';

    if (collectingArgs) {
      extraArgs.push(arg);
      continue;
    }

    if (arg === '--preset') {
      preset = argv[i + 1];
      i++;
    } else if (arg === '--env') {
      const val = argv[i + 1];
      if (val) {
        const eqIdx = val.indexOf('=');
        if (eqIdx > 0) {
          env[val.slice(0, eqIdx)] = val.slice(eqIdx + 1);
        }
      }
      i++;
    } else if (arg === '--command') {
      command = argv[i + 1];
      i++;
    } else if (arg === '--args') {
      collectingArgs = true;
    } else if (!arg.startsWith('-') && !name) {
      name = arg;
    }
  }

  return { name, preset, env, command, args: extraArgs };
}

function readMcpJson(): McpServerConfig[] | null {
  const path = join(homedir(), '.ethos', 'mcp.json');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: ~/.ethos/mcp.json contains invalid JSON. Fix it manually before adding servers.`);
    console.error(err instanceof Error ? err.message : String(err));
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.error('Error: ~/.ethos/mcp.json must be a JSON array. Fix it manually before adding servers.');
    return null;
  }
  return parsed as McpServerConfig[];
}

function writeMcpJson(configs: McpServerConfig[]): void {
  const dir = join(homedir(), '.ethos');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = join(dir, `mcp.json.tmp.${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(configs, null, 2)}\n`, 'utf8');
  renameSync(tmp, join(dir, 'mcp.json'));
}

function runAdd(argv: string[]): void {
  const parsed = parseAddArgs(argv);

  if (!parsed.name) {
    console.log(ADD_USAGE);
    return;
  }

  // Check for duplicate name
  const existing = readMcpJson();
  if (!existing) {
    process.exitCode = 1;
    return;
  }
  if (existing.some((s) => s.name === parsed.name)) {
    console.error(`MCP server '${parsed.name}' already exists in ~/.ethos/mcp.json`);
    console.error('Remove it first or choose a different name.');
    process.exitCode = 1;
    return;
  }

  let entry: McpServerConfig;

  if (parsed.preset) {
    const preset = getPreset(parsed.preset);
    if (!preset) {
      console.error(`Unknown preset: ${parsed.preset}`);
      console.error(`Available presets: ${Object.keys(MCP_PRESETS).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const envKeys = Object.keys(parsed.env);
    const envPassthrough = envKeys.length > 0 ? envKeys : undefined;

    entry = {
      name: parsed.name,
      transport: 'stdio',
      command: preset.command,
      args: preset.args,
      ...(envKeys.length > 0 ? { env: parsed.env } : {}),
      ...(envPassthrough ? { mcpEnvPassthrough: envPassthrough } : {}),
    };
  } else if (parsed.command) {
    const envKeys = Object.keys(parsed.env);
    const envPassthrough = envKeys.length > 0 ? envKeys : undefined;

    entry = {
      name: parsed.name,
      transport: 'stdio',
      command: parsed.command,
      ...(parsed.args.length > 0 ? { args: parsed.args } : {}),
      ...(envKeys.length > 0 ? { env: parsed.env } : {}),
      ...(envPassthrough ? { mcpEnvPassthrough: envPassthrough } : {}),
    };
  } else {
    console.error('Either --preset or --command is required.\n');
    console.log(ADD_USAGE);
    process.exitCode = 1;
    return;
  }

  existing.push(entry);
  writeMcpJson(existing);
  console.log(`Added MCP server '${parsed.name}' to ~/.ethos/mcp.json`);
}

// ---------------------------------------------------------------------------
// mcp presets — list available presets
// ---------------------------------------------------------------------------

function runPresets(): void {
  console.log('Available MCP server presets:\n');
  for (const preset of Object.values(MCP_PRESETS)) {
    const envHint = preset.envVars.length > 0 ? ` (env: ${preset.envVars.join(', ')})` : '';
    console.log(`  ${preset.name.padEnd(14)} ${preset.description}${envHint}`);
  }
  console.log('\nUsage: ethos mcp add <name> --preset <preset> [--env KEY=val ...]');
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
  console.log('  list_sessions       List recent sessions with metadata');
  console.log('  get_session         Get session metadata and first page of messages');
  console.log('  get_messages        Get messages from a session');
  console.log('  search_sessions     Full-text search across session messages');

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
