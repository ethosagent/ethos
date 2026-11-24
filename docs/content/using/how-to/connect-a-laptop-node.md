---
title: "Connect a laptop as a tool node"
description: "Let a personality on your Ethos server read, edit and run commands in folders on your laptop, with every write approved at the laptop's terminal."
kind: how-to
audience: user
slug: connect-a-laptop-node
time: "15 min"
updated: 2026-11-24
---

## Task

Give a personality on your always-on Ethos server hands on your laptop: it reads, searches and edits files in folders you choose, and runs commands there if you allow it. The laptop dials out, so NAT and firewalls do not matter.

## Result

- `ethos node connect` on the laptop opens one outbound `wss://` socket and stays up.
- A [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory and model) that lists the `node_*` tools in its `toolset.yaml` can use them.
- Writes and commands wait for a `y` at the laptop terminal. With the laptop offline, node tools fail at once with `node '<name>' is offline (last seen <time>)`.

## Prereqs

- An Ethos server run with `ethos boot` or `ethos serve` (the processes that run the web API), reachable over `https://`. Plain `http://` and `ws://` are refused for every host except loopback (`localhost`, `127.0.0.0/8`, `::1`); enforced by `assertSecureNodeUrl` in `extensions/execution-node/src/node-url.ts`, pinned by `node-client.test.ts` and `apps/ethos/src/__tests__/node-command.test.ts`.
- Ethos installed on the laptop (Node 24).
- Your ingress forwards WebSocket upgrades on `/node/ws` and `/node/pair`, and keeps an idle socket open for at least 30 s: the server pings both sockets every 25 s, a connected node on `/node/ws` and a pending pairing on `/node/pair` (`pingIntervalMs` in `apps/web-api/src/node/node-socket.ts`; pinned by `node-socket.test.ts`).

## Steps

### 1. Turn nodes on, on the server

Add to `~/.ethos/config.yaml` and restart `ethos boot`. The [`nodes` key](../reference/config-yaml/operations.md#nodes) mounts the routes and registers the tools; it is off by default.

```yaml
nodes.enabled: true
```

### 2. Give a personality the node tools

List the tools in the personality's `toolset.yaml`. A personality that does not list them gets `not permitted` when it calls one (`ToolRegistry` allowlist; pinned by `packages/wiring/src/__tests__/compose-tools-node.test.ts`).

```yaml
- node_read_file
- node_write_file
- node_patch_file
- node_search_files
- node_terminal
- node_list
```

### 3. Connect the laptop

```bash
ethos node connect https://ethos.example.com --root ~/code/app
```

```
No key stored for https://ethos.example.com; asking the server to pair this node as 'my-laptop'.
Pairing code: K7QM2XNB
On the server, run:  ethos node approve K7QM2XNB
Waiting for approval...
```

`--root <path>` is repeatable; `--root <path>:ro` exposes a folder read-only. The first root is where relative paths resolve.

### 4. Approve it on the server

Run on the machine where `ethos boot` runs, or inside its container (`kubectl exec`). The command reads the same `ETHOS_WEB_TOKEN` and `ETHOS_ALLOWED_ORIGINS` as the server; with an explicit allow-list it sends the first non-wildcard origin as `Origin` (`firstAllowedOrigin`, `apps/ethos/src/commands/node.ts`; pinned by `node-command.test.ts`):

```bash
ethos node approve K7QM2XNB
```

```
Approved node 'my-laptop'. The laptop receives its key and connects.
```

The laptop stores the key through its secrets store (`nodeKeyRef` in `packages/wiring/src/nodes.ts`) and prints `connected to https://ethos.example.com as 'my-laptop'`. Later runs reuse the key; a bare `ethos node connect https://ethos.example.com` also reuses the saved roots and flags.

### 5. Approve work at the laptop

When the personality writes, the laptop terminal asks:

```
[ethos node] approval needed (write)
  personality: laptop-hands
  tool:        patch_file
  path:        /Users/me/code/app/a.txt
  summary:     replace 5 chars with 5 chars: 'hello'
Allow? [y/N]
```

Only `y` or `yes` allows. No TTY, an empty answer, a cancelled call or 5 minutes of silence refuse (`NodeGuard.ask` in `extensions/execution-node/src/node-guard.ts`). Hidden characters (bidi overrides, zero-width and tag characters) show as `⟨U+XXXX⟩` instead of vanishing. The path and command are shown in full; a command over 8 KiB or a path over 4 KiB is refused. At most 8 approvals wait at once, and a call whose deadline passed while it waited is refused. An answer counts only if typed after the prompt was drawn (`createTtyApproval` in `apps/ethos/src/lib/node-tty.ts`; **limitation:** a line already read from the terminal in the same instant the prompt is drawn cannot be told apart).

## Options

| Flag | Default | Effect |
|---|---|---|
| `--writes ask\|auto` | `ask` | `auto` skips the write prompt. Read-only roots still refuse writes. |
| `--allow-terminal` / `--no-allow-terminal` | off | Enables or disables `node_terminal`. Every command still needs a `y`. The choice is saved, so `--no-allow-terminal` is how you turn it off again. |
| `--allow-unattended` / `--no-allow-unattended` | off | Accepts or refuses cron and other non-user turns. Saved like the terminal flag. |
| `--personality <id>` | any | Repeatable. Only these personalities may use the node. |
| `--name <n>` | hostname | Name shown by `node_list`. |
| `--pair` | off | Ignore the stored key and pair again. |

Every `connect` prints the effective policy (roots with their read-only flag, writes, terminal, unattended, personalities) once any pairing finishes and before it dials, so a saved flag is never a surprise. On a first connect the `policy:` line follows "Paired." and comes before `connected to ...`.

Shared rooms (group chats) are always refused by the proxy and by the node (`createNodeProxyTool` in `node-proxy.ts`, `NodeGuard.admit`).

## Verify

```bash
ethos node list
```

```
online   my-laptop  roots: /Users/me/code/app  last seen: 2026-11-24T10:00:00.000Z
```

Ask the personality to change a word in a file on the laptop, answer `y`, then `cat` the file.

## Revoke a node

```bash
ethos node revoke my-laptop
```

The key stops working at once. A live connection closes (code 4401) on the server's next 25 s ping tick and the laptop stops at once, without redialling, and the command exits with status `1`, with "key revoked or unknown — re-pair with `ethos node connect <url> --pair`" (`apps/web-api/src/node/node-socket.ts`, `NodeClient.onClose` in `extensions/execution-node/src/node-client.ts`; pinned by `node-e2e.test.ts`).

## Try it on one machine

Loopback needs no TLS. Use two state directories.

```bash
mkdir -p $TMP/proj && echo hello > $TMP/proj/a.txt && ln -s ~/.ssh $TMP/proj/keys
ETHOS_STATE_DIR=$TMP/srv ethos boot                      # nodes.enabled: true, web on 127.0.0.1:3000
ETHOS_STATE_DIR=$TMP/laptop ethos node connect http://127.0.0.1:3000 --root $TMP/proj
ETHOS_STATE_DIR=$TMP/srv ethos node approve <code>
```

1. Ask `laptop-hands` to change `hello` to `world` in `a.txt`. Answer `y`. `cat $TMP/proj/a.txt` shows `world`.
2. Ask it to read `keys/id_rsa`. It fails with `PATH_NOT_REACHABLE` and no prompt appears.
3. Stop the laptop command and repeat step 1: an immediate "node 'my-laptop' is offline (last seen ...)" error.
4. Run `ethos node revoke my-laptop`. The laptop stops within 25 s.

The same sequence runs without an LLM key in `apps/web-api/src/node/__tests__/node-e2e.test.ts`.

## Troubleshoot

| Symptom | Cause and fix |
|---|---|
| ``could not reach ... (is `ethos boot` running with nodes.enabled: true?)`` | `approve` and `list` call the running web API. Start it, or pass `--url <server>`. |
| `approve` or `list` fails with `UNAUTHORIZED` and the server's message | The server refused the call: a wrong web token or a CSRF origin mismatch. Run the command where the server runs, with the same `ETHOS_WEB_TOKEN` and `ETHOS_ALLOWED_ORIGINS`, or pass `--url <server>`. |
| `pairing ... failed` with HTTP 429 | Pairing is limited per peer address; see Limitations. Wait a minute. |
| `replaced by another connection using this key` | A second connection used the same key and won. If it was not you, run `ethos node revoke <name>`, then pair again. |
| `--root ... does not exist` | `connect` checks each root before dialling. |

## Limitations

These are the guarantees the feature does not make. Each names what enforces the part it does make.

- **Limitation:** inside a root, a compromised server can read everything the node allows without approval (D10 makes reads automatic). That is the feature's trust grant. Enforced boundary: `NodeGuard.admit` and `ScopedFsImpl` built by `buildNodeExecutor`.
- **Limitation:** an approved command runs as the laptop user with no path floor. The guard is best-effort by its own header (`extensions/tools-terminal/src/guard.ts`).
- **Limitation:** an impostor node receives what the agent sends, including write contents, and can return forged results. Detection is "two connections for one key": the newer connection wins and `node_list` flags the duplicate (D16).
- **Limitation:** TOCTOU stays open, as that file's header says (`packages/core/src/scoped/scoped-fs.ts`).
- **Limitation:** whatever is allowed travels to the server and to its LLM provider.
- **Limitation:** a compromised server can lie about the audience. The approval prompt is what actually protects the laptop.
- **Limitation:** `ScopedFsImpl.write` calls `Storage.write`, not `writeAtomic`, so a drop mid-write can leave a torn file. A `terminal` command killed mid-run is just as unguarded.
- `--writes auto` effectively permits code execution via `.git/hooks`, `.envrc` and `package.json` scripts: a write into a writable root can plant code the owner later runs.
- The sensitive-path floor refuses your real `~/.ssh` and the other absolute sensitive paths wherever a root reaches them (`sensitiveDenyPaths`, `packages/storage-fs/src/sensitive-paths.ts`; `node-executor.test.ts`). A key file copied into a project folder is just a file.
- Revoke reaches a live connection within 25 s, not instantly: the socket re-reads the key on each ping tick.
- One write is bounded by the 4 MiB frame (`NODE_FRAME_MAX_BYTES`, `extensions/execution-node/src/frames.ts`).
- Only a process that runs the web API (`ethos boot`, `ethos serve`) serves nodes; the desktop app does not. With `nodes.enabled: true`, `ethos chat` and other commands that build an agent loop still register the `node_*` tools (`composeAllTools`, `packages/wiring/src/compose-tools.ts`), but nothing there hosts the socket, so every call finds no connected node.
- Approvals happen only at the laptop's terminal. The Settings page has no Approve button yet; use `ethos node approve`.
- Pairing is rate-limited per peer address (`NodePairing.canAccept`, `apps/web-api/src/node/node-pairing.ts`): 5 pending requests, 5 attempts a minute, 10-minute codes. Behind an ingress every laptop shares the ingress's address, so they share one bucket, unless `ETHOS_TRUST_PROXY=1` makes the bucket key the first `X-Forwarded-For` value (`clientKeyOf`, `apps/web-api/src/middleware/rate-limit.ts`). A `pair_request` advertises at most 32 roots of 1024 characters each (`decodeRoots`, `extensions/execution-node/src/frames.ts`).
