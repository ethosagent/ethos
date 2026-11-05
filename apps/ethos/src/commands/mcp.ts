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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ethosDir, readConfig, readRawConfig } from '@ethosagent/config';
import type { ClientAdapter, McpEntry } from '@ethosagent/mcp-server';
import {
  claudeDesktop,
  continueClient,
  cursor,
  EthosMcpServer,
  logger as mcpLogger,
  opencode,
  PersonalityExportServer,
  zed,
} from '@ethosagent/mcp-server';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import type {
  DcrResponse,
  DiscoveredOAuthMetadata,
  McpServerConfig,
  OAuthConfig,
  StartDeviceResult,
  TokenSet,
} from '@ethosagent/tools-mcp';
import {
  dcrGrantTypes,
  discoverOAuthMetadata,
  getPreset,
  issuerFields,
  LoginSlots,
  MCP_PRESETS,
  McpDeviceLogin,
  McpJsonStore,
  McpPasteLogin,
  mcpEnvSecretRef,
  PastedRedirectError,
  registerOAuthClient,
  revokeToken,
  runDcrAuthorization,
  runPkceLogin,
  startCallbackServer,
  storeEnvSecrets,
  validateMcpServerName,
} from '@ethosagent/tools-mcp';
import { EthosError, type SecretsResolver } from '@ethosagent/types';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  createApprovalDangerPredicate,
  createLazyProvider,
  createMcpClientAuthenticator,
  createMemoryProviderFromConfig,
  createSessionStore,
  detectContainerized,
  resolveMcpExportScope,
} from '@ethosagent/wiring';
import { writeJson } from '../json-output';
import { gateNonInteractiveLoop } from '../lib/non-interactive-approval';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { StderrLogger } from '../logger';
import {
  createAgentLoop,
  createLLM,
  getEthosObservability,
  getSecretsResolver,
  getStorage,
} from '../wiring';
import {
  buildExportEntry,
  createExportApprovalGate,
  createMcpExportAuditSink,
  exportEntryName,
  exportLauncher,
  exportServeGate,
  formatExportError,
  formatExportSummary,
  resolveExportWorkingDir,
} from './mcp-export';
import { buildPresetArgs, collectArgFlags } from './mcp-preset-args';

const mcpStore = new McpJsonStore(getStorage());

const CLIENTS: ClientAdapter[] = [claudeDesktop, cursor, opencode, continueClient, zed];

const USAGE = `Usage: ethos mcp <subcommand> [options]

Subcommands:
  serve [options]  Start the Ethos MCP server
    --http           Use Streamable HTTP transport instead of stdio
    --port <n>       HTTP port (default: 3300, implies --http)
    --personality <id>  Export ONE personality (its mcp_export declaration)
  install <client> Install Ethos into a supported MCP client's config
    --personality <id>  Install that personality's export as 'ethos-<id>'
  init [client]    Print quick-start config snippet
  doctor           Verify server configuration
  inspect          List available tools, resources, and prompts
  add <name>       Add an MCP server to ~/.ethos/mcp.json
    --preset <name>  Use a built-in preset (see 'ethos mcp presets')
    --url <mcpUrl>   Remote MCP server URL (runs OAuth discovery + DCR)
    --device | --paste | --browser  How --url signs in (see 'login'); default: detected
    --no-qr          Do not print a QR code for device sign-in
    --env KEY=val    Set environment variable (repeatable)
    --arg NAME=val   Supply a preset's command-line value (repeatable)
  presets          List available MCP server presets
  login <name>     Authenticate with an OAuth-configured MCP server
    --personality <id>  Store the grant for that personality
    --device         Show a code to enter on any device (RFC 8628)
    --paste          Open a URL anywhere, then paste back the address it ends on
    --browser        Open a browser on this machine (default on a desktop)
    --no-qr          Do not print a QR code for --device
                     (headless hosts — ssh, containers, Linux without a display —
                     default to --device, then --paste)
  logout <name>    Revoke and delete tokens for an MCP server
  registry list    Browse MCP server packages from npm
    --search <q>     Filter by keyword
  registry install <package>  Install a package as an MCP server

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
      return runDoctor(argv.slice(1));
    case 'inspect':
      return runInspect(argv.slice(1));
    case 'add':
      return runAdd(argv.slice(1));
    case 'presets':
      return runPresets(argv.slice(1));
    case 'login':
      return runLogin(argv.slice(1));
    case 'logout':
      return runLogout(argv.slice(1));
    case 'registry':
      return runRegistry(argv.slice(1));
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
  let personalityId: string | undefined;
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
    } else if (arg === '--personality') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        console.error('--personality requires a personality id');
        process.exitCode = 1;
        return;
      }
      personalityId = next;
      i++;
    }
  }

  // Two different servers behind one subcommand (M-D1/M-D14): without the flag
  // this is the operator console — full trust, every personality, every session
  // on the machine. With it, ONE personality bounded by its own `mcp_export`.
  if (personalityId !== undefined) {
    return runServeExport({ personalityId, useHttp, port });
  }

  const storage = getStorage();
  const config = await readConfig(storage, await getSecretsResolver());
  if (!config) {
    // Must go to stderr — stdout must remain pure JSON-RPC
    process.stderr.write(
      JSON.stringify({ level: 'error', msg: 'No ~/.ethos/config.yaml found. Run: ethos setup' }) +
        '\n',
    );
    process.exit(1);
  }
  const runtime = await createAgentLoop(config);
  gateNonInteractiveLoop(runtime, config, 'an MCP client cannot show an approval prompt');
  const sessionStore = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
  // The memory tools read and write through the SAME backend the agent does
  // (`createMemoryProviderFromConfig`, packages/wiring/src/memory-backend.ts);
  // scope comes from the caller's `personality_id` (`personalityMemoryContext`,
  // apps/mcp-server/src/memory-scope.ts). This console is full trust and
  // installed explicitly, so writes are on.
  const memory = createMemoryProviderFromConfig({
    config,
    dataDir: ethosDir(),
    storage,
  });
  const server = new EthosMcpServer({
    loop: runtime.loop,
    dataDir: ethosDir(),
    storage,
    logger: mcpLogger,
    sessionStore,
    memoryProvider: memory.provider,
    enableMemoryWrite: true,
  });

  // `ethos mcp serve` runs until its client goes away, so the only shutdown it
  // has is the signal. Memoised: a second Ctrl-C must not start a second
  // teardown. Stop serving first, then release the loop, then close the
  // sessions.db handle THIS command opened (the loop closes its own).
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      // Stop accepting work before draining it.
      await server.close().catch((err: unknown) => {
        process.stderr.write(
          `[shutdown] mcp server: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
      await releaseCommandRuntime(runtime, {
        label: 'mcp agent loop',
        also: [['mcp sessions.db', async () => sessionStore.close()]],
      });
      process.exit(0);
    })();
    return shuttingDown;
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (useHttp) {
    await server.serveHttp({ port });
    // Keep process alive — the HTTP server handles shutdown
  } else {
    await server.start();
    // Keep process alive — the stdio transport handles shutdown
  }
}

/**
 * `ethos mcp serve --personality <id>` — publish ONE personality to ONE
 * external MCP client, bounded by that personality's own `mcp_export`
 * declaration (M-T7, plan/phases/trust-before-reach.md Part 3).
 *
 * This function is the composition root the export server is built by, and it
 * is deliberately the only place four things are decided:
 *
 *  - the admission check (`exportServeGate`, M-D4) — an unknown id or an export
 *    that is not literally `enabled: true` exits 1 with JSON on stderr;
 *  - the pinned working directory (`resolveExportWorkingDir`, M-D11);
 *  - the fail-closed approval hook (`createExportApprovalGate`, M-D10);
 *  - which secret a stdio client presented (`ETHOS_MCP_KEY`).
 *
 * `resolveScope` and `authenticator` are INJECTED into the server rather than
 * imported by it (M-D13): the server holds no opinion about where a scope or a
 * key comes from, so a second host can supply different ones without the export
 * surface growing a dependency on `@ethosagent/wiring`.
 */
async function runServeExport(opts: {
  personalityId: string;
  useHttp: boolean;
  port: number;
}): Promise<void> {
  const { personalityId, useHttp, port } = opts;
  const refuse = (refusal: Parameters<typeof formatExportError>[0]): void => {
    // stderr, always — a client that already spawned us reads stdout as
    // JSON-RPC frames and a stray line there corrupts the stream.
    process.stderr.write(formatExportError(refusal));
  };

  const storage = getStorage();
  const config = await readConfig(storage, await getSecretsResolver());
  if (!config) {
    refuse({
      ok: false,
      code: 'unknown_personality',
      message: 'No ~/.ethos/config.yaml found. Run: ethos setup',
    });
    process.exit(1);
  }

  const dataDir = ethosDir();
  const runtime = await createAgentLoop(config, {
    profile: 'mcp',
    // M-D6 — an external client's text must never become the operator's memory
    // or skills. This is the flag that stops it, not a preference.
    disablePostTurnLearning: true,
    // M-D11 — never the launcher's cwd.
    workingDir: resolveExportWorkingDir({ personalityId, dataDir }),
  });

  // The gate reads THIS loop's registry (M-D13) — the one the turn will run
  // against — so boot and every later call answer from one mtime cache.
  await runtime.refreshPersonalities();
  const personality = runtime.personalities.get(personalityId);
  const scope = personality ? resolveMcpExportScope(personality, runtime.toolRegistry) : undefined;
  const gate = exportServeGate({ personalityId, personality, scope, http: useHttp });
  if (!gate.ok) {
    refuse(gate);
    await runtime.dispose().catch(() => {});
    process.exit(1);
  }
  // M-D10 — approval fails closed. There is no human at an MCP transport to
  // answer a prompt, so a dangerous call is REJECTED rather than queued or
  // waved through. Registering this also satisfies core's approval-posture
  // guard, which throws at the first tool dispatch when a `gated` loop has
  // nothing behind its `before_tool_call` fire site.
  const { scope: admitted } = gate;
  const danger = createApprovalDangerPredicate({
    hooks: [runtime.loop.hooks],
    personalities: runtime.personalities,
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    // The smart reviewer's decision site from THIS build (plan
    // decision-provider-jev §8.2); absent → the LLM reviewer only.
    ...(runtime.approverDecision ? { decision: runtime.approverDecision } : {}),
    executionPostureFor: runtime.executionPostureFor,
    usageMeter: runtime.usageMeter,
  });
  runtime.loop.hooks.registerModifying('before_tool_call', createExportApprovalGate(danger));

  // Conversation tools and the transcript both live in sessions.db; the store
  // comes from wiring (M-D13), and the caller that opened it closes it.
  const sessionStore = createSessionStore({
    dataDir,
    ...(config.retention ? { retention: config.retention } : {}),
  });
  // Bearer only. Under `localhost` no key is read, so no store is opened.
  const keyStore =
    admitted.auth === 'bearer' ? new SqliteApiKeyStore(join(dataDir, 'sessions.db')) : undefined;
  const authenticator = keyStore
    ? createMcpClientAuthenticator({ personalityId, keys: keyStore })
    : undefined;
  const stdioSecret = process.env.ETHOS_MCP_KEY?.trim();

  const server = new PersonalityExportServer({
    personalityId,
    loop: runtime.loop,
    personalities: runtime.personalities,
    refreshPersonalities: runtime.refreshPersonalities,
    toolRegistry: runtime.toolRegistry,
    resolveScope: resolveMcpExportScope,
    logger: mcpLogger,
    ...(authenticator ? { authenticator } : {}),
    ...(stdioSecret ? { stdioSecret } : {}),
    sessionStore,
    audit: createMcpExportAuditSink((event) => {
      getEthosObservability().recordEthosEvent(event);
    }),
  });

  let shuttingDown: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      await server.close().catch((err: unknown) => {
        process.stderr.write(
          `[shutdown] mcp export server: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
      const also: Array<readonly [string, () => Promise<void>]> = [
        ['mcp export sessions.db', async () => sessionStore.close()],
      ];
      if (keyStore) also.push(['mcp export api keys', async () => keyStore.close()]);
      await releaseCommandRuntime(runtime, { label: 'mcp export agent loop', also });
      process.exit(0);
    })();
    return shuttingDown;
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    if (useHttp) {
      await server.serveHttp({ port });
    } else {
      await server.start();
    }
  } catch (err) {
    // `serveHttp` refuses a non-bearer export and a missing authenticator by
    // throwing. `exportServeGate` catches the first before we get here; this
    // turns anything left into the same readable JSON line rather than an
    // unhandled stack trace on a client's stderr.
    refuse({
      ok: false,
      code: 'missing_authenticator',
      message: err instanceof Error ? err.message : String(err),
    });
    await runtime.dispose().catch(() => {});
    process.exit(1);
  }

  // One line, the operator's only chance to see what they just published.
  process.stderr.write(`${formatExportSummary(personalityId, admitted)}\n`);
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

  const personalityIdx = argv.indexOf('--personality');
  const personalityId =
    personalityIdx === -1 ? undefined : (argv[personalityIdx + 1] ?? '').trim() || undefined;
  if (personalityIdx !== -1 && !personalityId) {
    console.error('--personality requires a personality id');
    process.exitCode = 1;
    return;
  }

  const launcher = exportLauncher();
  const scriptPath = launcher.scriptPath;
  const install = (entry: McpEntry): void => {
    const configPath = adapter.configPath();
    const existing = adapter.readConfig(configPath);
    const serialised = adapter.serialise(adapter.injectEntry(existing, entry));
    if (!existsSync(dirname(configPath))) {
      mkdirSync(dirname(configPath), { recursive: true });
    }
    writeFileSync(configPath, serialised, 'utf8');
    console.log(`  Config: ${configPath}`);
  };

  if (personalityId === undefined) {
    install({ command: launcher.command, args: [scriptPath, 'mcp', 'serve'] });
    console.log(`✓ Installed Ethos MCP server into ${adapter.displayName}`);
    return;
  }

  await installPersonalityExport({ adapter, personalityId, scriptPath, install });
}

/**
 * `ethos mcp install <client> --personality <id>` — write an `ethos-<id>` entry
 * BESIDE whatever `ethos` entry the client already has (M-D14: the console and
 * an export are different surfaces with different trust, so installing one must
 * never remove the other). Every adapter keys off `McpEntry.name`, so the two
 * cannot collide.
 *
 * Under `auth: 'bearer'` this also mints the client's key with scope
 * `mcp:<id>` (M-D9) straight into the entry's `env` as `ETHOS_MCP_KEY`. Only
 * the PREFIX is printed: the full secret goes to the client's own config file
 * and never to the terminal's scrollback, where it would outlive the install in
 * a shell history, a screen share or a CI log.
 */
async function installPersonalityExport(opts: {
  adapter: ClientAdapter;
  personalityId: string;
  scriptPath: string;
  install: (entry: McpEntry) => void;
}): Promise<void> {
  const { adapter, personalityId, scriptPath } = opts;
  const storage = getStorage();
  const config = await readConfig(storage, await getSecretsResolver());
  if (!config) {
    console.error('No ~/.ethos/config.yaml found. Run: ethos setup');
    process.exitCode = 1;
    return;
  }

  // Read the declaration through a real loop's registry, the same one
  // `ethos mcp serve --personality` gates on, so install and serve can never
  // disagree about whether an export exists or which auth it wants.
  const runtime = await createAgentLoop(config, { profile: 'mcp' });
  try {
    await runtime.refreshPersonalities();
    const personality = runtime.personalities.get(personalityId);
    const scope = personality
      ? resolveMcpExportScope(personality, runtime.toolRegistry)
      : undefined;
    const gate = exportServeGate({ personalityId, personality, scope, http: false });
    if (!gate.ok) {
      console.error(gate.message);
      process.exitCode = 1;
      return;
    }

    let secret: string | undefined;
    let prefix: string | undefined;
    let keyStore: SqliteApiKeyStore | undefined;
    if (gate.scope.auth === 'bearer') {
      keyStore = new SqliteApiKeyStore(join(ethosDir(), 'sessions.db'));
      try {
        const minted = await keyStore.create({
          name: `${adapter.displayName} — ${personalityId}`,
          scopes: [`mcp:${personalityId}`],
        });
        secret = minted.secret;
        prefix = minted.record.prefix;
      } finally {
        keyStore.close();
      }
    }

    opts.install(
      buildExportEntry({
        command: exportLauncher().command,
        scriptPath,
        personalityId,
        ...(secret ? { secret } : {}),
      }),
    );
    console.log(`✓ Installed ${exportEntryName(personalityId)} into ${adapter.displayName}`);
    console.log(`  ${formatExportSummary(personalityId, gate.scope)}`);
    if (prefix) {
      console.log(`  Client key: ${prefix}  (written to the entry's ETHOS_MCP_KEY)`);
      console.log(`  Revoke with: ethos api-key revoke ${prefix}`);
    }
  } finally {
    await releaseCommandRuntime(runtime, { label: 'mcp install agent loop', drainMs: 0 });
  }
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
  --url <mcpUrl>   Remote MCP server URL (runs OAuth discovery + DCR)
  --device         With --url: sign in with a code entered on any device (RFC 8628)
  --paste          With --url: open a URL anywhere, paste back the address it ends on
  --browser        With --url: sign in through a browser on this machine
                   (at most one of the three; default: detected from the host)
  --no-qr          With --device: do not print a QR code
  --env KEY=val    Set environment variable (repeatable)
  --arg NAME=val   Supply a preset's command-line value (repeatable).
                   Appended to the preset's args in declaration order —
                   see the 'arg:' hints in 'ethos mcp presets'.

Without --preset or --url, you must provide --command and optionally --args:
  --command <cmd>  Server command (e.g. 'npx')
  --args <a> ...   Command arguments (consumes remaining positional args)

Examples:
  ethos mcp add fs --preset filesystem --arg ALLOWED_PATH=/data
  ethos mcp add my-git --preset git --arg GIT_REPO_PATH=/repos/myapp
  ethos mcp add mem --preset memory --env MEMORY_FILE_PATH=/data/memory.json
  ethos mcp add custom --command npx --args -y @myorg/mcp-server
  ethos mcp add linear --url https://mcp.linear.app/mcp`;

function parseAddArgs(argv: string[]): {
  name?: string;
  preset?: string;
  url?: string;
  env: Record<string, string>;
  argValues: Record<string, string>;
  command?: string;
  args: string[];
} {
  const env: Record<string, string> = {};
  // Collected by the one exported implementation, which is also what the unit
  // test drives — see commands/mcp-preset-args.ts.
  const argValues = collectArgFlags(argv);
  const extraArgs: string[] = [];
  let name: string | undefined;
  let preset: string | undefined;
  let url: string | undefined;
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
    } else if (arg === '--url') {
      url = argv[i + 1];
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
    } else if (arg === '--arg') {
      // Value already collected by `collectArgFlags` above; skip past it so it
      // is not mistaken for the positional server name.
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

  return { name, preset, url, env, argValues, command, args: extraArgs };
}

async function readMcpJson(): Promise<McpServerConfig[]> {
  return mcpStore.read();
}

/**
 * `--env KEY=value` values are credential material more often than not
 * (API tokens for the server subprocess). G-SEC forbids writing a secret
 * value into an MCP server config, so the value goes to the SecretsResolver
 * and `mcp.json` gets the `${secrets:ref}` — resolved at spawn time by
 * McpClient. Returns the map to persist in place of the raw values.
 */
async function persistEnvSecrets(
  serverName: string,
  env: Record<string, string>,
): Promise<Record<string, string>> {
  if (Object.keys(env).length === 0) return {};
  return storeEnvSecrets(serverName, env, await getSecretsResolver());
}

async function runAdd(argv: string[]): Promise<void> {
  const parsed = parseAddArgs(argv);
  // Flag conflicts are refused before anything is read or written.
  const loginFlags = parseLoginFlowFlags(argv);

  if (!parsed.name) {
    console.log(ADD_USAGE);
    return;
  }

  // UBP-035 — the server name becomes part of every tool name the providers
  // see (mcp__<server>__<tool>), so refuse one they would reject.
  const nameError = validateMcpServerName(parsed.name);
  if (nameError) {
    console.error(nameError);
    process.exitCode = 1;
    return;
  }

  // Check for duplicate name
  const existing = await readMcpJson();
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

    const built = buildPresetArgs(preset, parsed.argValues, parsed.name);
    if (!built.ok) {
      console.error(built.error);
      process.exitCode = 1;
      return;
    }

    const envKeys = Object.keys(parsed.env);
    const envPassthrough = envKeys.length > 0 ? envKeys : undefined;
    const envRefs = await persistEnvSecrets(parsed.name, parsed.env);

    entry = {
      name: parsed.name,
      transport: 'stdio',
      command: preset.command,
      args: built.args,
      ...(envKeys.length > 0 ? { env: envRefs } : {}),
      ...(envPassthrough ? { mcpEnvPassthrough: envPassthrough } : {}),
    };
  } else if (parsed.command) {
    const envKeys = Object.keys(parsed.env);
    const envPassthrough = envKeys.length > 0 ? envKeys : undefined;
    const envRefs = await persistEnvSecrets(parsed.name, parsed.env);

    entry = {
      name: parsed.name,
      transport: 'stdio',
      command: parsed.command,
      ...(parsed.args.length > 0 ? { args: parsed.args } : {}),
      ...(envKeys.length > 0 ? { env: envRefs } : {}),
      ...(envPassthrough ? { mcpEnvPassthrough: envPassthrough } : {}),
    };
  } else if (parsed.url) {
    const flow = chooseLoginFlow({ flag: loginFlags.flag, ...hostSignals() });
    const urlResult = await runAddUrl(parsed.name, parsed.url, flow);
    if (!urlResult) return;
    entry = urlResult.entry;

    await mcpStore.upsert(entry.name, entry);

    console.log(`Added MCP server '${parsed.name}' to ~/.ethos/mcp.json`);
    if (flow === 'browser') {
      console.log(`Run 'ethos mcp login ${parsed.name} --personality <id>' to authenticate.`);
      return;
    }
    // device / paste: discovery + DCR only above, so the one sign-in happens
    // here, for the resolved personality (plan D15) — no second approval later.
    const resolved = await resolvePersonalitySecrets(undefined);
    try {
      await runHeadlessLogin(
        {
          serverName: parsed.name,
          personalityId: resolved.personalityId,
          flow,
          noQr: loginFlags.noQr,
        },
        await buildHeadlessDeps(),
      );
    } catch (err) {
      process.stderr.write(
        `The server was added; retry sign-in with: ethos mcp login ${parsed.name}${resolved.personalityId ? ` --personality ${resolved.personalityId}` : ''}\n`,
      );
      throw err;
    }
    return;
  } else {
    console.error('Either --preset, --url, or --command is required.\n');
    console.log(ADD_USAGE);
    process.exitCode = 1;
    return;
  }

  await mcpStore.upsert(entry.name, entry);
  console.log(`Added MCP server '${parsed.name}' to ~/.ethos/mcp.json`);
  for (const key of Object.keys(parsed.env)) {
    console.log(
      `  ${key} stored as secret '${mcpEnvSecretRef(parsed.name, key)}' — mcp.json holds only the reference.`,
    );
  }
}

interface UrlAddResult {
  entry: McpServerConfig;
  /** Present only for the browser flow; device / paste sign in after the entry is saved. */
  tokens?: TokenSet;
  registrationAccessToken?: string;
}

/**
 * Discovery + dynamic client registration, no authorization. The redirect URI
 * registered is a real loopback URI (a listener is bound only to learn a free
 * port, then closed): paste sign-in later reuses exactly this string from
 * `dcr.redirect_uri` (plan D10; McpPasteLogin.start in tools-mcp).
 */
async function registerClientOnly(mcpUrl: string): Promise<{
  meta: DiscoveredOAuthMetadata;
  dcrResult: DcrResponse;
  redirectUri: string;
  tokens?: undefined;
}> {
  const meta = await discoverOAuthMetadata(mcpUrl);
  if (!meta.registration_endpoint) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'MCP server does not support dynamic client registration',
      action: 'Use a preset, or add the server with a pre-registered client in mcp.json.',
    });
  }
  const callback = await startCallbackServer();
  const redirectUri = callback.redirectUri;
  callback.close();
  // The device grant is requested only where discovery advertised the endpoint:
  // dcrGrantTypes, pinned by tools-mcp __tests__/oauth-dcr.test.ts.
  const dcrResult = await registerOAuthClient(meta.registration_endpoint, {
    redirect_uris: [redirectUri],
    client_name: 'Ethos',
    token_endpoint_auth_method: 'none',
    grant_types: dcrGrantTypes(meta),
    response_types: ['code'],
  });
  return { meta, dcrResult, redirectUri };
}

function buildUrlEntry(
  name: string,
  mcpUrl: string,
  meta: DiscoveredOAuthMetadata,
  dcrResult: DcrResponse,
  redirectUri: string,
): McpServerConfig {
  return {
    name,
    transport: 'streamable-http',
    url: mcpUrl,
    auth: {
      type: 'oauth2',
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      client_id: dcrResult.client_id,
      ...(meta.revocation_endpoint ? { revocation_endpoint: meta.revocation_endpoint } : {}),
      ...(meta.introspection_endpoint
        ? { introspection_endpoint: meta.introspection_endpoint }
        : {}),
      // Persisted so `ethos mcp login --device` can run without re-discovery.
      ...(meta.device_authorization_endpoint
        ? { device_authorization_endpoint: meta.device_authorization_endpoint }
        : {}),
      // Persisted so `ethos mcp login` / refresh bind the grant to this issuer
      // and enforce RFC 9207 `iss` (plan hermes-0.22-hardening §4.2 step 2).
      ...issuerFields(meta),
      dcr: {
        registration_endpoint: meta.registration_endpoint ?? '',
        ...(dcrResult.client_id_issued_at != null
          ? { client_id_issued_at: dcrResult.client_id_issued_at }
          : {}),
        ...(dcrResult.registration_client_uri
          ? { registration_client_uri: dcrResult.registration_client_uri }
          : {}),
        // The URI that was registered; paste sign-in reuses it verbatim (plan D10).
        redirect_uri: redirectUri,
      },
    },
    created_via: 'cli',
  };
}

async function runAddUrl(
  name: string,
  mcpUrl: string,
  flow: LoginFlow,
): Promise<UrlAddResult | null> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mcpUrl);
  } catch {
    console.error(`Invalid URL: ${mcpUrl}`);
    process.exitCode = 1;
    return null;
  }
  if (parsedUrl.protocol !== 'https:') {
    console.error('Remote MCP server URL must use https://');
    process.exitCode = 1;
    return null;
  }

  process.stderr.write('Discovering OAuth metadata...\n');

  try {
    const { meta, dcrResult, redirectUri, tokens } =
      flow === 'browser'
        ? await runDcrAuthorization(mcpUrl, 'Ethos', (url) => {
            process.stderr.write(`\nOpen this URL to authorize:\n${url}\n\n`);
          })
        : await registerClientOnly(mcpUrl);
    return {
      entry: buildUrlEntry(name, mcpUrl, meta, dcrResult, redirectUri),
      ...(tokens ? { tokens } : {}),
      ...(dcrResult.registration_access_token
        ? { registrationAccessToken: dcrResult.registration_access_token }
        : {}),
    };
  } catch (err) {
    console.error(`OAuth setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return null;
  }
}

// ---------------------------------------------------------------------------
// mcp presets — list available presets
// ---------------------------------------------------------------------------

function runPresets(argv: string[]): void {
  if (argv.includes('--json')) {
    const presets = Object.values(MCP_PRESETS).map((preset) => ({
      name: preset.name,
      description: preset.description,
      envVars: preset.envVars,
      argVars: preset.argVars,
    }));
    writeJson(presets);
    return;
  }

  console.log('Available MCP server presets:\n');
  for (const preset of Object.values(MCP_PRESETS)) {
    const hints: string[] = [];
    if (preset.argVars.length > 0) hints.push(`arg: ${preset.argVars.join(', ')}`);
    if (preset.envVars.length > 0) hints.push(`env: ${preset.envVars.join(', ')}`);
    const hint = hints.length > 0 ? ` (${hints.join('; ')})` : '';
    console.log(`  ${preset.name.padEnd(14)} ${preset.description}${hint}`);
  }
  console.log(
    '\nUsage: ethos mcp add <name> --preset <preset> [--arg NAME=val ...] [--env KEY=val ...]',
  );
  console.log("An 'arg:' value is required — the server reads it from its command line.");
}

function runDoctor(argv: string[]): void {
  const execPath = process.execPath;
  const scriptPath = process.argv[1] ?? 'ethos';

  if (argv.includes('--json')) {
    const clients = CLIENTS.map((adapter) => {
      const path = adapter.configPath();
      return {
        name: adapter.name,
        displayName: adapter.displayName,
        configPath: path,
        installed: existsSync(path),
      };
    });
    writeJson({
      node: execPath,
      script: scriptPath,
      command: `${execPath} ${scriptPath} mcp serve`,
      clients,
    });
    return;
  }

  console.log('Ethos MCP doctor\n');
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

function runInspect(argv: string[]): void {
  if (argv.includes('--json')) {
    writeJson({
      tools: [
        { name: 'ask_personality', description: 'Run a prompt through a specific personality' },
        { name: 'list_personalities', description: 'List all available personalities' },
        { name: 'list_sessions', description: 'List recent sessions with metadata' },
        { name: 'get_session', description: 'Get session metadata and first page of messages' },
        { name: 'get_messages', description: 'Get messages from a session' },
        { name: 'search_sessions', description: 'Full-text search across session messages' },
        { name: 'search_memory', description: "Search one personality's memory" },
        { name: 'read_memory', description: "Read one key from a personality's memory" },
        { name: 'write_memory', description: "Write one key in a personality's memory" },
      ],
      resources: [
        { uri: 'ethos://memory/<id>/<key>', description: "A personality's memory key" },
        { uri: 'ethos://sessions/recent', description: 'Recent sessions' },
        { uri: 'ethos://personalities/<id>/SOUL.md', description: 'Personality identity' },
      ],
      prompts: [
        { name: 'code_review', description: 'Structured code review' },
        { name: 'research_topic', description: 'Deep research with citations' },
        { name: 'reflect_on_decision', description: 'Coaching reflection' },
        { name: 'debug_failure', description: 'Evidence-first failure investigation' },
      ],
    });
    return;
  }

  console.log('Tools:\n');
  console.log('  ask_personality     Run a prompt through a specific personality');
  console.log('  list_personalities  List all available personalities');
  console.log('  list_sessions       List recent sessions with metadata');
  console.log('  get_session         Get session metadata and first page of messages');
  console.log('  get_messages        Get messages from a session');
  console.log('  search_sessions     Full-text search across session messages');
  console.log("  search_memory       Search one personality's memory");
  console.log("  read_memory         Read one key from a personality's memory");
  console.log("  write_memory        Write one key in a personality's memory");

  console.log('\nResources:\n');
  console.log("  ethos://memory/<id>/<key>           A personality's memory key");
  console.log('  ethos://sessions/recent             Recent sessions');
  console.log('  ethos://personalities/<id>/SOUL.md  Personality identity');

  console.log('\nPrompts:\n');
  console.log('  code_review          Structured code review');
  console.log('  research_topic       Deep research with citations');
  console.log('  reflect_on_decision  Coaching reflection');
  console.log('  debug_failure        Evidence-first failure investigation');
}

// ---------------------------------------------------------------------------
// mcp registry — browse and install MCP servers from npm
// ---------------------------------------------------------------------------

async function runRegistry(argv: string[]): Promise<void> {
  const sub = argv[0] ?? '';
  switch (sub) {
    case 'list':
      return runRegistryList(argv.slice(1));
    case 'install':
      return runRegistryInstall(argv.slice(1));
    default:
      console.log(`Usage: ethos mcp registry <list|install> [options]

  list [--search <q>]     Browse MCP server packages from npm
  install <package>       Install a package as an MCP server`);
  }
}

async function runRegistryList(argv: string[]): Promise<void> {
  let search = '';
  const json = argv.includes('--json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--search' && argv[i + 1]) {
      search = argv[i + 1] ?? '';
      i++;
    }
  }

  const url = `https://registry.npmjs.org/-/v1/search?text=keywords:mcp-server${search ? `+${search}` : ''}&size=20`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Registry query failed: ${res.status}`);
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as {
    objects: Array<{ package: { name: string; description?: string; version: string } }>;
  };

  if (json) {
    const packages = data.objects.map((obj) => ({
      name: obj.package.name,
      version: obj.package.version,
      description: obj.package.description ?? null,
    }));
    writeJson(packages);
    return;
  }

  if (data.objects.length === 0) {
    console.log('No packages found.');
    return;
  }

  console.log('MCP server packages:\n');
  for (const obj of data.objects) {
    const pkg = obj.package;
    console.log(`  ${pkg.name}@${pkg.version}`);
    if (pkg.description) console.log(`    ${pkg.description}`);
  }
  console.log(`\nInstall: ethos mcp registry install <package>`);
}

async function runRegistryInstall(argv: string[]): Promise<void> {
  const packageName = argv[0];
  if (!packageName) {
    console.error('Usage: ethos mcp registry install <package>');
    process.exitCode = 1;
    return;
  }

  const name = packageName.replace(/^@[^/]+\//, '').replace(/^server-/, '');

  const existing = await readMcpJson();
  if (existing.some((s) => s.name === name)) {
    console.error(`Server '${name}' already exists.`);
    process.exitCode = 1;
    return;
  }

  const entry: McpServerConfig = {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', packageName],
  };

  await mcpStore.upsert(entry.name, entry);
  console.log(`Installed '${name}' (${packageName}) to ~/.ethos/mcp.json`);
}

// ---------------------------------------------------------------------------
// mcp login / logout — OAuth 2.1 PKCE flows
// ---------------------------------------------------------------------------

function parsePersonalityFlag(argv: string[]): {
  serverName?: string;
  personalityId?: string;
  error?: string;
} {
  let serverName: string | undefined;
  let personalityId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--personality') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        return { error: '--personality requires a value' };
      }
      personalityId = next;
      i++;
    } else if (!arg?.startsWith('--') && !serverName) {
      serverName = arg;
    }
  }
  return { serverName, personalityId };
}

async function resolvePersonalitySecrets(
  explicitId: string | undefined,
): Promise<{ secrets: SecretsResolver; personalityId: string | undefined }> {
  const secrets = await getSecretsResolver();
  let personalityId = explicitId;

  if (!personalityId) {
    const raw = await readRawConfig(getStorage());
    if (raw) {
      personalityId = raw.activeContext?.name ?? raw.personality;
    }
  }

  if (personalityId) {
    return { secrets: new PersonalityScopedSecrets(secrets, personalityId), personalityId };
  }
  return { secrets, personalityId: undefined };
}

// ---------------------------------------------------------------------------
// Headless sign-in — device code (RFC 8628) and paste-the-redirect
// (plan mcp-device-code-login §6). Prompts go to stderr; nothing auto-opens a
// browser; the user code is printed to the user and nowhere else (the poller and
// McpDeviceLogin in tools-mcp never log it — pinned by tools-mcp
// __tests__/device-login.test.ts "no secret reaches the logger").
// ---------------------------------------------------------------------------

export type LoginFlow = 'device' | 'paste' | 'browser';

/** `--device | --paste | --browser` and `--no-qr`. More than one flow flag is refused. */
export function parseLoginFlowFlags(argv: string[]): { flag?: LoginFlow; noQr: boolean } {
  const flags = (['device', 'paste', 'browser'] as const).filter((f) => argv.includes(`--${f}`));
  if (flags.length > 1) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Pass at most one of --device, --paste, --browser (got ${flags.map((f) => `--${f}`).join(', ')})`,
      action: 'Usage: ethos mcp login <name> [--personality <id>] [--device | --paste | --browser]',
    });
  }
  return { ...(flags[0] ? { flag: flags[0] } : {}), noQr: argv.includes('--no-qr') };
}

/**
 * Which sign-in flow to run. An explicit flag wins. Otherwise a headless host
 * (ssh session, Linux with no display, a container) gets `device`, and anything
 * else keeps today's `browser`. Headless detection lives here, not in
 * extensions/tools-mcp, which may not read process.env (plan D6;
 * tools-read-env-through-ctx). Pinned by __tests__/mcp-login-flow.test.ts.
 */
export function chooseLoginFlow(input: {
  flag?: LoginFlow;
  env: Record<string, string | undefined>;
  platform: string;
  containerized: boolean;
}): LoginFlow {
  if (input.flag) return input.flag;
  const { env } = input;
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  const noDisplay = input.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  return ssh || noDisplay || input.containerized ? 'device' : 'browser';
}

/** The live host's signals for `chooseLoginFlow`. Only auto-detected container signals count (not ETHOS_EXECUTION_BACKEND). */
function hostSignals(): { env: NodeJS.ProcessEnv; platform: string; containerized: boolean } {
  return {
    env: process.env,
    platform: process.platform,
    containerized: detectContainerized({
      env: { KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST },
    }).containerized,
  };
}

/** Terminal side effects of a headless sign-in, injected so tests run without a TTY. */
export interface LoginIo {
  err(text: string): void;
  out(text: string): void;
  isTTY: boolean;
  now(): number;
  /** Reads one line. Rejects with a cancellation (see `isLoginCancelled`) on Ctrl+C or EOF. */
  readLine(prompt: string): Promise<string>;
  /** Registers a Ctrl+C handler; returns its remover. */
  onSigint(handler: () => void): () => void;
  qr(url: string): Promise<void>;
  /** Releases stdin if a read is still pending. */
  endInput(): void;
}

export interface HeadlessLoginDeps {
  device: Pick<McpDeviceLogin, 'start' | 'onSettled' | 'cancel'>;
  paste: Pick<McpPasteLogin, 'start' | 'complete' | 'cancel'>;
  /** Paste sign-in for an entry saved before `dcr.redirect_uri` was stored: a fresh loopback port, plus the paste. */
  legacyPaste(input: {
    serverName: string;
    personalityId?: string;
    onAuthUrl(url: string): void;
    pasted: Promise<string>;
  }): Promise<void>;
  io: LoginIo;
}

export interface HeadlessLoginInput {
  serverName: string;
  personalityId?: string;
  flow: 'device' | 'paste';
  noQr: boolean;
}

const MAX_PASTE_ATTEMPTS = 3;

function loginCancelled(): EthosError {
  return new EthosError({
    code: 'INVALID_INPUT',
    cause: 'Sign-in cancelled',
    action: 'Run the command again to retry.',
    details: { cancelled: true },
  });
}

export function isLoginCancelled(err: unknown): boolean {
  return (
    err instanceof EthosError &&
    typeof err.details === 'object' &&
    err.details !== null &&
    (err.details as { cancelled?: unknown }).cancelled === true
  );
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

function headerLines(info: {
  serverName: string;
  personalityId?: string;
  serverHost: string;
  authHost: string;
}): string {
  const who = info.personalityId ? ` for personality '${info.personalityId}'` : '';
  return (
    `Sign in to '${info.serverName}'${who}\n` +
    `  server:              ${info.serverHost}\n` +
    `  authorization host:  ${info.authHost}\n`
  );
}

function declined(): EthosError {
  return new EthosError({
    code: 'UNAUTHORIZED',
    cause: 'Sign-in was declined in the browser.',
    action: 'Run the command again to retry.',
  });
}

function failedWith(code: string): EthosError {
  return new EthosError({
    code: 'UNAUTHORIZED',
    cause: `Sign-in failed (${code}).`,
    action: 'Run the command again to retry.',
  });
}

function startFailure(serverName: string, r: { code: string; detail?: string }): EthosError {
  if (r.code === 'not_found') {
    return new EthosError({
      code: 'MCP_SERVER_NOT_FOUND',
      cause: `MCP server '${serverName}' not found in ~/.ethos/mcp.json`,
      action: 'Run `ethos mcp add` first.',
    });
  }
  if (r.code === 'not_oauth') {
    return new EthosError({
      code: 'INVALID_INPUT',
      cause: `MCP server '${serverName}' does not have OAuth 2.1 auth configured`,
      action: 'Only OAuth servers need sign-in.',
    });
  }
  if (r.code === 'discovery_failed') {
    return new EthosError({
      code: 'NETWORK_ERROR',
      cause: `Could not reach the authorization server for '${serverName}'.`,
      action: 'Check the network and run the command again.',
    });
  }
  return new EthosError({
    code: 'INVALID_INPUT',
    cause: r.detail ?? `Sign-in could not start (${r.code}).`,
    action: 'Wait for the other sign-in to finish, or run the command again.',
  });
}

/**
 * Sign in without a local browser, once. `device` falls through to `paste` (with
 * a reason line) when the server has no device grant or refuses it (plan D3);
 * it never re-registers the client (D5). Ctrl+C stores nothing and sets exit
 * code 130. Outcomes surface as EthosError, never raw Error.
 */
export async function runHeadlessLogin(
  input: HeadlessLoginInput,
  deps: HeadlessLoginDeps,
): Promise<void> {
  const { io } = deps;
  let cancelFlow: (() => void) | undefined;
  try {
    if (input.flow === 'device') {
      const started = await deps.device.start({
        serverName: input.serverName,
        personalityId: input.personalityId,
        surface: 'cli',
      });
      if (started.ok) {
        cancelFlow = () => deps.device.cancel(started.flowId);
        await awaitDevice(input, started, deps);
        return;
      }
      if (started.code !== 'device_unavailable' && started.code !== 'device_refused') {
        throw startFailure(input.serverName, started);
      }
      io.err(
        `Device sign-in is not available for '${input.serverName}' (${started.detail ?? started.code}); using paste instead.\n`,
      );
    }
    if (!io.isTTY) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Cannot sign in to '${input.serverName}' here: device sign-in is unavailable and paste needs an interactive terminal`,
        action: `Run it in a terminal (for example 'ssh -t'), or on a machine with a browser: ethos mcp login ${input.serverName} --browser`,
      });
    }
    await pasteSignIn(input, deps, (cancel) => {
      cancelFlow = cancel;
    });
  } catch (err) {
    cancelFlow?.();
    if (isLoginCancelled(err)) {
      io.err('\nCancelled — nothing was stored.\n');
      process.exitCode = 130;
      return;
    }
    throw err;
  } finally {
    io.endInput();
  }
}

async function awaitDevice(
  input: HeadlessLoginInput,
  started: Extract<StartDeviceResult, { ok: true }>,
  deps: HeadlessLoginDeps,
): Promise<void> {
  const { io } = deps;
  io.err(
    `${headerLines(started)}` +
      `  open:                ${started.verificationUri}\n` +
      `  enter code:          ${started.userCode}\n` +
      `  expires in:          ${formatRemaining(started.expiresAt - io.now())}\n`,
  );
  if (!input.noQr && started.verificationUriComplete) {
    io.err('(QR of the complete URL below — pass --no-qr to hide)\n');
    await io.qr(started.verificationUriComplete);
  }
  io.err('Waiting… press Ctrl+C to cancel.\n');
  io.err('If you did not just run this command, ignore the code and do not enter it anywhere.\n');

  const settled = new Promise<{ status: string; reason?: string }>((resolve) => {
    deps.device.onSettled(started.flowId, resolve);
  });
  let off = (): void => {};
  const interrupted = new Promise<never>((_, reject) => {
    off = io.onSigint(() => reject(loginCancelled()));
  });
  let result: { status: string; reason?: string };
  try {
    result = await Promise.race([settled, interrupted]);
  } finally {
    off();
  }
  reportOutcome(input, result, io);
}

function reportOutcome(
  input: HeadlessLoginInput,
  result: { status: string; reason?: string },
  io: LoginIo,
): void {
  switch (result.status) {
    case 'connected': {
      const scope = input.personalityId ? ` (personality: ${input.personalityId})` : '';
      io.out(`Successfully authenticated with '${input.serverName}'${scope}\n`);
      return;
    }
    case 'denied':
      throw declined();
    case 'expired':
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'The code expired before it was approved.',
        action: 'Run the command again.',
      });
    case 'cancelled':
      throw loginCancelled();
    default:
      throw failedWith(result.reason ?? 'error');
  }
}

const PASTE_PROMPT =
  "After you approve, your browser will fail to load a 127.0.0.1 page. Copy that page's address and paste it here:\n";

async function pasteSignIn(
  input: HeadlessLoginInput,
  deps: HeadlessLoginDeps,
  setCancel: (cancel: () => void) => void,
): Promise<void> {
  const { io } = deps;
  const started = await deps.paste.start({
    serverName: input.serverName,
    personalityId: input.personalityId,
    surface: 'cli',
  });
  if (!started.ok) {
    if (started.code !== 'paste_unavailable') throw startFailure(input.serverName, started);
    await legacyPasteSignIn(input, deps);
    return;
  }
  const flowId = started.flowId;
  setCancel(() => deps.paste.cancel(flowId));
  io.err(
    `${headerLines(started)}Open this URL in any browser:\n${started.authorizeUrl}\n\n${PASTE_PROMPT}`,
  );
  for (let attempt = 1; attempt <= MAX_PASTE_ATTEMPTS; attempt++) {
    const line = await io.readLine('> ');
    const done = await deps.paste.complete(flowId, line);
    if (done.ok) {
      reportOutcome(input, { status: 'connected' }, io);
      return;
    }
    if (done.code === 'denied') throw declined();
    if (done.code !== 'invalid_paste' && done.code !== 'state_mismatch') {
      throw failedWith(done.code);
    }
    io.err(
      done.code === 'state_mismatch'
        ? 'That address belongs to a different sign-in attempt. Paste the one from this sign-in:\n'
        : "That is not the address to paste. It starts with http://127.0.0.1 and contains 'code='. Try again:\n",
    );
  }
  throw failedWith('invalid_paste');
}

async function legacyPasteSignIn(
  input: HeadlessLoginInput,
  deps: HeadlessLoginDeps,
): Promise<void> {
  const { io } = deps;
  let resolvePasted: (text: string) => void = () => {};
  let rejectPasted: (err: unknown) => void = () => {};
  const pasted = new Promise<string>((resolve, reject) => {
    resolvePasted = resolve;
    rejectPasted = reject;
  });
  io.err(
    `'${input.serverName}' has no stored redirect address (it was added before paste sign-in); using a fresh local one.\n`,
  );
  try {
    await deps.legacyPaste({
      serverName: input.serverName,
      personalityId: input.personalityId,
      onAuthUrl: (url) => {
        io.err(`\nOpen this URL in any browser:\n${url}\n\n${PASTE_PROMPT}`);
        io.readLine('> ').then(resolvePasted, rejectPasted);
      },
      pasted,
    });
  } catch (err) {
    if (isLoginCancelled(err) || err instanceof EthosError) throw err;
    if (err instanceof PastedRedirectError) {
      if (err.code === 'access_denied') throw declined();
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: err.message,
        action: 'Run the command again.',
      });
    }
    throw new EthosError({
      code: 'UNAUTHORIZED',
      cause: `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
      action: 'Run the command again.',
    });
  }
  reportOutcome(input, { status: 'connected' }, io);
}

function createStdioLoginIo(): LoginIo {
  let rl: ReturnType<typeof createInterface> | undefined;
  return {
    err: (text) => void process.stderr.write(text),
    out: (text) => void process.stdout.write(text),
    isTTY: Boolean(process.stdin.isTTY),
    now: () => Date.now(),
    readLine: (prompt) =>
      new Promise<string>((resolve, reject) => {
        const reader = createInterface({ input: process.stdin, output: process.stderr });
        rl = reader;
        let answered = false;
        reader.once('close', () => {
          if (!answered) reject(loginCancelled());
        });
        reader.once('SIGINT', () => reader.close());
        reader.question(prompt, (line) => {
          answered = true;
          reader.close();
          resolve(line);
        });
      }),
    onSigint: (handler) => {
      process.once('SIGINT', handler);
      return () => void process.off('SIGINT', handler);
    },
    qr: async (url) => {
      try {
        const qrterm = await import('qrcode-terminal');
        qrterm.generate(url, { small: true }, (code: string) => {
          process.stderr.write(`${code}\n`);
        });
      } catch {
        // The URL is printed regardless; a missing QR renderer is cosmetic.
      }
    },
    endInput: () => rl?.close(),
  };
}

/** Wire McpDeviceLogin / McpPasteLogin to the CLI: one shared pending map, the real secrets, no live McpManager to reconnect. */
export async function buildHeadlessDeps(): Promise<HeadlessLoginDeps> {
  const secrets = await getSecretsResolver();
  // Audit lines (`mcp.oauth.login`) go to stderr (StderrLogger) so stdout stays pipeable
  // user-facing output; no secret reaches the logger
  // (tools-mcp __tests__/device-login.test.ts "no secret reaches the logger").
  const logger = new StderrLogger({ component: 'mcp' });
  const slots = new LoginSlots({ logger });
  const mcpManager = {
    registerConfig: (): void => {},
    reconnectPersonality: async (): Promise<void> => {},
  };
  const common = { mcpJsonStore: mcpStore, secrets, mcpManager, slots, logger };
  return {
    device: new McpDeviceLogin(common),
    paste: new McpPasteLogin(common),
    io: createStdioLoginIo(),
    legacyPaste: async ({ serverName, personalityId, onAuthUrl, pasted }) => {
      const config = await mcpStore.get(serverName);
      if (config?.auth?.type !== 'oauth2') return;
      await runPkceLogin(
        serverName,
        config.auth,
        personalityId ? new PersonalityScopedSecrets(secrets, personalityId) : secrets,
        { onAuthUrl, pasted },
      );
    },
  };
}

async function runLogin(argv: string[]): Promise<void> {
  const { serverName, personalityId, error } = parsePersonalityFlag(argv);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  if (!serverName) {
    console.error(
      'Usage: ethos mcp login <serverName> [--personality <id>] [--device | --paste | --browser] [--no-qr]',
    );
    process.exitCode = 1;
    return;
  }
  const loginFlags = parseLoginFlowFlags(argv);

  const configs = await readMcpJson();

  const config = configs.find((c) => c.name === serverName);
  if (!config) {
    console.error(`MCP server '${serverName}' not found in ~/.ethos/mcp.json`);
    process.exitCode = 1;
    return;
  }

  if (config.auth?.type !== 'oauth2') {
    console.error(`MCP server '${serverName}' does not have OAuth 2.1 auth configured`);
    process.exitCode = 1;
    return;
  }

  const resolved = await resolvePersonalitySecrets(personalityId);
  const oauthConfig: OAuthConfig = config.auth;

  const flow = chooseLoginFlow({ flag: loginFlags.flag, ...hostSignals() });
  if (flow !== 'browser') {
    await runHeadlessLogin(
      {
        serverName,
        personalityId: resolved.personalityId,
        flow,
        noQr: loginFlags.noQr,
      },
      await buildHeadlessDeps(),
    );
    return;
  }

  try {
    await runPkceLogin(serverName, oauthConfig, resolved.secrets);
    const scope = resolved.personalityId ? ` (personality: ${resolved.personalityId})` : '';
    console.log(`Successfully authenticated with '${serverName}'${scope}`);
  } catch (err) {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function runLogout(argv: string[]): Promise<void> {
  const { serverName, personalityId, error } = parsePersonalityFlag(argv);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  if (!serverName) {
    console.error('Usage: ethos mcp logout <serverName> [--personality <id>]');
    process.exitCode = 1;
    return;
  }

  const configs = await readMcpJson();

  const config = configs.find((c) => c.name === serverName);
  if (!config) {
    console.error(`MCP server '${serverName}' not found in ~/.ethos/mcp.json`);
    process.exitCode = 1;
    return;
  }

  const oauthConfig: OAuthConfig | undefined =
    config.auth?.type === 'oauth2' ? config.auth : undefined;

  if (!oauthConfig) {
    console.error(`MCP server '${serverName}' does not have OAuth 2.1 auth configured`);
    process.exitCode = 1;
    return;
  }

  const resolved = await resolvePersonalitySecrets(personalityId);

  try {
    await revokeToken(serverName, oauthConfig, resolved.secrets);
    const scope = resolved.personalityId ? ` (personality: ${resolved.personalityId})` : '';
    console.log(`Logged out of '${serverName}' — tokens revoked and deleted${scope}`);
  } catch (err) {
    console.error(`Logout failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
