import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { ethosDir, readConfig } from '@ethosagent/config';
import { EthosError, type SecretsResolver, type Storage } from '@ethosagent/types';
import {
  assertSecureNodeUrl,
  buildNodeExecutor,
  decodeApproveResult,
  decodeNodeAdminList,
  listNodeKeys,
  NODE_NAME_RE,
  NODE_SOCKET_PATH,
  NodeClient,
  type NodeClientStatus,
  NodeGuard,
  type NodeRoot,
  type NodeSocketFactory,
  type NodeState,
  nodeCommandCheck,
  nodeKeyRef,
  pairNode,
  readNodeState,
  revokeNodeKeys,
  writeNodeState,
} from '@ethosagent/wiring/nodes';
import { createTtyApproval, oneLine } from '../lib/node-tty';
import { resolveAllowedOrigins, resolveWebPort } from './serve-helpers';

// `ethos node` — the laptop side (`connect`) and the server operator side (`list | approve |
// revoke`) of the laptop tool node (plan laptop-tool-node T9, brief D2). `connect` dials out;
// approve/list talk to the running web-api over cookie-authenticated HTTP
// (apps/web-api/src/node/node-admin-routes.ts); revoke flips the key row in sessions.db and the
// live socket drops on its next 25 s ping tick (apps/web-api/src/node/node-socket.ts).
// `--json` is supported by `list` and `revoke`.

export interface NodeCommandDeps {
  storage: Storage;
  secrets: SecretsResolver;
  stateDir: string;
  dataDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  socketFactory?: NodeSocketFactory;
  /** Structural subset of `fetch`, so tests inject a plain function. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The web-api cookie token. Default: `WebTokenRepository.getOrCreate` via dynamic import. */
  webToken: () => Promise<string | null>;
  /** The first explicit, non-wildcard ETHOS_ALLOWED_ORIGINS entry, else undefined. */
  allowedOrigin: () => string | undefined;
  /** Default: `http://127.0.0.1:<resolveWebPort([], process.env, config)>`. */
  defaultServerUrl: () => Promise<string>;
  /** Backoff jitter source for reconnects; default `Math.random` (test seam). */
  random?: () => number;
  /** Registers the stop function for SIGINT/SIGTERM. Default: process signals. */
  onSignal?: (stop: () => Promise<void>) => void;
}

const USAGE = [
  'Usage: ethos node connect <url> [--root <path>[:ro]]... [--name <n>] [--personality <id>]...',
  '                          [--allow-terminal|--no-allow-terminal] [--writes ask|auto]',
  '                          [--allow-unattended|--no-allow-unattended] [--pair]',
  '       ethos node list [--url <server>] [--json]',
  '       ethos node approve <code> [--url <server>]',
  '       ethos node revoke <name> [--json]',
].join('\n');

const REVOKE_LATENCY = 'the live connection closes within 25 s (next ping tick)';

const invalid = (cause: string, action = USAGE): EthosError =>
  new EthosError({ code: 'INVALID_INPUT', cause, action });

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Parsed {
  positional: string[];
  roots: string[];
  personalities: string[];
  name?: string;
  writes?: string;
  url?: string;
  /** Undefined when neither `--allow-X` nor `--no-allow-X` was given: the saved value stands. */
  allowTerminal?: boolean;
  allowUnattended?: boolean;
  pair: boolean;
  json: boolean;
}

function parseArgs(args: string[]): Parsed {
  const p: Parsed = {
    positional: [],
    roots: [],
    personalities: [],
    pair: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i] ?? '';
    if (!raw.startsWith('--')) {
      p.positional.push(raw);
      continue;
    }
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const value = (): string => {
      const v = inline ?? args[++i];
      if (v === undefined || v === '') throw invalid(`${flag} needs a value`);
      return v;
    };
    const allow = /^--(no-)?allow-(terminal|unattended)$/.exec(flag);
    if (allow) {
      if (allow[2] === 'terminal') p.allowTerminal = allow[1] === undefined;
      else p.allowUnattended = allow[1] === undefined;
      continue;
    }
    switch (flag) {
      case '--root':
        p.roots.push(value());
        break;
      case '--personality':
        p.personalities.push(value());
        break;
      case '--name':
        p.name = value();
        break;
      case '--writes':
        p.writes = value();
        break;
      case '--url':
        p.url = value();
        break;
      case '--pair':
        p.pair = true;
        break;
      case '--json':
        p.json = true;
        break;
      default:
        throw invalid(`unknown flag ${flag}`);
    }
  }
  return p;
}

function defaultNodeName(): string {
  const cleaned = hostname()
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 63);
  return NODE_NAME_RE.test(cleaned) ? cleaned : 'laptop';
}

async function parseRoots(specs: string[], storage: Storage): Promise<NodeRoot[]> {
  const roots: NodeRoot[] = [];
  for (const spec of specs) {
    const readOnly = spec.endsWith(':ro');
    const path = resolve(readOnly ? spec.slice(0, -3) : spec);
    if (!(await storage.exists(path))) {
      throw invalid(`root '${path}' does not exist`, 'Create the folder or fix the --root path.');
    }
    roots.push({ path, readOnly });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

async function pairForKey(
  url: string,
  node: { name: string; roots: NodeRoot[] },
  d: NodeCommandDeps,
): Promise<string> {
  d.stdout(`No key stored for ${url}; asking the server to pair this node as '${node.name}'.\n`);
  try {
    const { key } = await pairNode({
      url,
      name: node.name,
      roots: node.roots,
      ...(d.socketFactory && { socketFactory: d.socketFactory }),
      onCode: (code) =>
        d.stdout(
          `Pairing code: ${code}\nOn the server, run:  ethos node approve ${code}\nWaiting for approval...\n`,
        ),
    });
    await d.secrets.set(nodeKeyRef(url), key);
    d.stdout("Paired. The key is stored in this machine's secrets store.\n");
    return key;
  } catch (e) {
    throw new EthosError({
      code: 'NETWORK_ERROR',
      cause: `pairing with ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
      action: 'Check the URL, that the server runs with nodes.enabled: true, and retry.',
    });
  }
}

/** What this node will let the server do, printed on every connect (verification m1). */
function describePolicy(s: NodeState): string {
  const roots = s.roots.map((r) => `${oneLine(r.path)}${r.readOnly ? ' (read-only)' : ''}`);
  return [
    `policy: roots ${roots.join(', ')}`,
    `writes ${s.writes}`,
    `terminal ${s.allowTerminal ? 'ON' : 'off'}`,
    `unattended ${s.allowUnattended ? 'ON' : 'off'}`,
    `personalities ${s.personalities.map((x) => oneLine(x)).join(', ')}`,
  ].join('; ');
}

async function runConnect(args: string[], d: NodeCommandDeps): Promise<number> {
  const p = parseArgs(args);
  const saved = await readNodeState(d.storage, d.stateDir);
  const url = p.positional[0] ?? saved?.server;
  if (!url) throw invalid('connect needs a server URL');
  try {
    assertSecureNodeUrl(url, NODE_SOCKET_PATH);
  } catch (e) {
    throw invalid(
      e instanceof Error ? e.message : String(e),
      'Use https:// (loopback may use http://).',
    );
  }

  const roots = p.roots.length > 0 ? await parseRoots(p.roots, d.storage) : (saved?.roots ?? []);
  if (roots.length === 0) throw invalid('connect needs at least one --root <path>[:ro]');
  const name = p.name ?? saved?.name ?? defaultNodeName();
  if (!NODE_NAME_RE.test(name)) throw invalid(`--name '${name}' must match ${NODE_NAME_RE.source}`);
  const writes = p.writes ?? saved?.writes ?? 'ask';
  if (writes !== 'ask' && writes !== 'auto') throw invalid("--writes must be 'ask' or 'auto'");
  const state: NodeState = {
    server: url,
    name,
    roots,
    personalities: p.personalities.length > 0 ? p.personalities : (saved?.personalities ?? ['*']),
    allowTerminal: p.allowTerminal ?? saved?.allowTerminal ?? false,
    writes,
    allowUnattended: p.allowUnattended ?? saved?.allowUnattended ?? false,
  };

  const stored = p.pair ? null : await d.secrets.get(nodeKeyRef(url));
  const key = stored ?? (await pairForKey(url, state, d));
  await writeNodeState(d.storage, d.stateDir, state);

  if (state.writes === 'auto') {
    d.stderr(
      '--writes auto: writes need no approval; a write into a writable root can plant code you later run (.git/hooks, .envrc, package.json scripts).\n',
    );
  }
  d.stdout(`${describePolicy(state)}\n`);
  const executor = buildNodeExecutor({
    roots: state.roots,
    allowTerminal: state.allowTerminal,
    storage: d.storage,
    stateDir: d.stateDir,
  });
  const guard = new NodeGuard({
    policy: {
      roots: state.roots,
      tools: executor.toolNames,
      personalities: state.personalities,
      writes: state.writes,
      allowUnattended: state.allowUnattended,
    },
    approve: createTtyApproval({
      input: d.stdin,
      output: { write: (s) => d.stdout(s) },
      isTTY: d.stdin.isTTY === true,
    }),
    checkCommand: nodeCommandCheck,
  });

  const exitCode = await new Promise<number>((done) => {
    const onStatus = (status: NodeClientStatus, detail?: string, retryInMs?: number): void => {
      switch (status) {
        case 'connected':
          d.stdout(`connected to ${url} as '${name}' (Ctrl-C to disconnect)\n`);
          return;
        case 'disconnected':
          d.stdout(
            `disconnected${detail ? ` (${oneLine(detail)})` : ''}; retrying in ${Math.round((retryInMs ?? 0) / 100) / 10}s\n`,
          );
          return;
        case 'unauthorized':
          d.stderr(`key revoked or unknown — re-pair with \`ethos node connect ${url} --pair\`\n`);
          void d.secrets.delete(nodeKeyRef(url)).finally(() => done(1));
          return;
        case 'replaced':
          d.stderr(`${detail ?? 'replaced by another connection using this key'}\n`);
          done(1);
          return;
        case 'stopped':
          done(0);
          return;
        default:
          return;
      }
    };
    const client = new NodeClient({
      url,
      key,
      hello: {
        name,
        roots: state.roots,
        tools: [...executor.toolNames],
        personalities: state.personalities,
      },
      guard,
      execute: executor.execute,
      ...(d.socketFactory && { socketFactory: d.socketFactory }),
      ...(d.random && { random: d.random }),
      onStatus,
    });
    const stop = async (): Promise<void> => {
      await client.stop();
    };
    if (d.onSignal) d.onSignal(stop);
    else {
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());
    }
    client.start();
  });
  // createTtyApproval resumed stdin for the session; a flowing TTY keeps the process alive.
  d.stdin.pause();
  return exitCode;
}

// ---------------------------------------------------------------------------
// list | approve | revoke
// ---------------------------------------------------------------------------

async function adminRequest(
  d: NodeCommandDeps,
  server: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<{ url: string; status: number; body: unknown }> {
  const base = server.replace(/\/+$/, '');
  const url = `${base}${path}`;
  const token = await d.webToken();
  if (!token) {
    throw new EthosError({
      code: 'NOT_CONFIGURED',
      cause: 'no web token found on this machine',
      action: 'Run this on the machine where `ethos boot` runs, after it has started once.',
    });
  }
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    throw invalid(`not a valid server URL: ${server}`);
  }
  // Behind an explicit ETHOS_ALLOWED_ORIGINS the server's CSRF check refuses the loopback origin.
  // This CLI runs in the server's environment, so the same variable applies (verification M3).
  origin = d.allowedOrigin() ?? origin;
  try {
    const res = await d.fetch(url, {
      method: init.method,
      headers: {
        Cookie: `ethos_auth=${token}`,
        Origin: origin,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (res.status === 401 || res.status === 403) {
      const msg =
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string'
          ? body.error
          : `the server answered ${res.status}`;
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: `${url} refused the request: ${oneLine(msg)}`,
        action:
          'Run this where the server runs (same ETHOS_WEB_TOKEN and ETHOS_ALLOWED_ORIGINS), or pass --url <server>.',
      });
    }
    return { url, status: res.status, body };
  } catch (e) {
    if (e instanceof EthosError) throw e;
    throw new EthosError({
      code: 'NETWORK_ERROR',
      cause: `could not reach ${url}: ${e instanceof Error ? e.message : String(e)} (is \`ethos boot\` running with nodes.enabled: true?)`,
      action: 'Start `ethos boot` with nodes.enabled: true, or pass --url <server>.',
    });
  }
}

const unexpected = (url: string): EthosError =>
  new EthosError({
    code: 'NETWORK_ERROR',
    cause: `unexpected response from ${url}`,
    action: 'Is `ethos boot` running with nodes.enabled: true, and is --url the right server?',
  });

async function runList(args: string[], d: NodeCommandDeps): Promise<number> {
  const p = parseArgs(args);
  const server = p.url ?? (await d.defaultServerUrl());
  const res = await adminRequest(d, server, '/node/admin/list', { method: 'GET' });
  const list = res.status === 200 ? decodeNodeAdminList(res.body) : null;
  if (!list) throw unexpected(res.url);
  if (p.json) {
    d.stdout(`${JSON.stringify(list)}\n`);
    return 0;
  }
  if (list.nodes.length === 0) d.stdout('No nodes have connected.\n');
  for (const n of list.nodes) {
    const roots = n.roots.map((r) => `${oneLine(r.path)}${r.readOnly ? ':ro' : ''}`).join(', ');
    d.stdout(
      `${n.online ? 'online ' : 'offline'}  ${oneLine(n.name)}  roots: ${roots}  last seen: ${oneLine(n.lastSeen)}\n`,
    );
  }
  for (const q of list.pending) {
    d.stdout(
      `pending  ${oneLine(q.name)}  code: ${oneLine(q.code)}  (ethos node approve ${oneLine(q.code)})\n`,
    );
  }
  return 0;
}

async function runApprove(args: string[], d: NodeCommandDeps): Promise<number> {
  const p = parseArgs(args);
  const code = p.positional[0];
  if (!code) throw invalid('approve needs a pairing code');
  const server = p.url ?? (await d.defaultServerUrl());
  const res = await adminRequest(d, server, '/node/admin/approve', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  const result = decodeApproveResult(res.body);
  if (!result) throw unexpected(res.url);
  if (result.ok) {
    d.stdout(`Approved node '${result.name}'. The laptop receives its key and connects.\n`);
    return 0;
  }
  if (result.reason === 'expired') {
    throw invalid(
      `pairing code ${code} expired`,
      'Re-run `ethos node connect <url> --pair` on the laptop.',
    );
  }
  if (result.reason === 'connection_closed') {
    throw invalid(
      `the laptop for pairing code ${code} disconnected before approval; the minted key was revoked`,
      'Re-run `ethos node connect <url> --pair` on the laptop.',
    );
  }
  throw new EthosError({
    code: 'NOT_FOUND',
    cause: `no pending pairing with code ${code}`,
    action: 'Check the code printed by `ethos node connect`, or run `ethos node list`.',
  });
}

async function runRevoke(args: string[], d: NodeCommandDeps): Promise<number> {
  const p = parseArgs(args);
  const name = p.positional[0];
  if (!name) throw invalid('revoke needs a node name');
  const revoked = await revokeNodeKeys(d.dataDir, name);
  if (revoked === 0) {
    const known = (await listNodeKeys(d.dataDir)).map((k) => k.name);
    throw new EthosError({
      code: 'NOT_FOUND',
      cause: `no live key for node '${name}'`,
      action:
        known.length > 0
          ? `Known nodes: ${[...new Set(known)].join(', ')}`
          : 'No nodes are paired.',
    });
  }
  if (p.json) d.stdout(`${JSON.stringify({ name, revoked })}\n`);
  else d.stdout(`Revoked ${revoked} key(s) for node '${name}'; ${REVOKE_LATENCY}.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function defaultServerUrl(d: Pick<NodeCommandDeps, 'storage' | 'secrets'>): Promise<string> {
  let config = null;
  try {
    config = await readConfig(d.storage, d.secrets);
  } catch {
    // No readable config: the default port applies.
  }
  return `http://127.0.0.1:${resolveWebPort([], process.env, config)}`;
}

function firstAllowedOrigin(): string | undefined {
  // Reuses the server's own parser, so wildcard refusal and trimming match `ethos serve`.
  const list = resolveAllowedOrigins(process.env);
  return list?.find((o) => !o.startsWith('*'));
}

async function resolveDeps(over: Partial<NodeCommandDeps>): Promise<NodeCommandDeps> {
  // Lazy: tests inject both and never load the CLI wiring graph.
  const storage = over.storage ?? (await import('../wiring')).getStorage();
  const secrets = over.secrets ?? (await (await import('../wiring')).getSecretsResolver());
  const dataDir = over.dataDir ?? ethosDir();
  return {
    storage,
    secrets,
    stateDir: over.stateDir ?? ethosDir(),
    dataDir,
    stdout: over.stdout ?? ((s) => void process.stdout.write(s)),
    stderr: over.stderr ?? ((s) => void process.stderr.write(s)),
    stdin: over.stdin ?? process.stdin,
    ...(over.socketFactory && { socketFactory: over.socketFactory }),
    fetch: over.fetch ?? globalThis.fetch,
    allowedOrigin: over.allowedOrigin ?? firstAllowedOrigin,
    webToken:
      over.webToken ??
      (async () => {
        // Same construction as boot.ts: ETHOS_WEB_TOKEN wins and no token file is minted.
        const { WebTokenRepository, resolveWebTokenEnv } = await import('@ethosagent/web-api');
        const envToken = resolveWebTokenEnv();
        return new WebTokenRepository({
          dataDir,
          storage,
          ...(envToken !== undefined ? { envToken } : {}),
        }).getOrCreate();
      }),
    defaultServerUrl: over.defaultServerUrl ?? (() => defaultServerUrl({ storage, secrets })),
    ...(over.random && { random: over.random }),
    ...(over.onSignal && { onSignal: over.onSignal }),
  };
}

/** Returns the process exit code. Throws `EthosError` for bad input and unreachable servers. */
export async function runNode(
  args: string[],
  deps: Partial<NodeCommandDeps> = {},
): Promise<number> {
  const sub = args[0];
  if (sub !== 'connect' && sub !== 'list' && sub !== 'approve' && sub !== 'revoke') {
    throw invalid(sub ? `unknown subcommand '${sub}'` : 'missing subcommand');
  }
  const d = await resolveDeps(deps);
  const rest = args.slice(1);
  switch (sub) {
    case 'connect':
      return runConnect(rest, d);
    case 'list':
      return runList(rest, d);
    case 'approve':
      return runApprove(rest, d);
    case 'revoke':
      return runRevoke(rest, d);
  }
}
