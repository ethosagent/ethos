# ethos-vscode

## Purpose

A VS Code sidebar for Ethos (`displayName` "Ethos"). It registers a webview view `ethos.chat` and spawns the `ethos acp` subprocess, then speaks ACP JSON-RPC to it over stdio. The extension is private and has no runtime dependencies.

## Public surface

This is an app (no library exports). Entry points:

| Export | Kind | One line |
|---|---|---|
| `activate` | function | Extension entry (`src/extension.ts`, `main` is `dist/extension.js`); registers the view and commands. |
| `deactivate` | function | Disposes the view provider. |
| `EthosViewProvider` | class | Webview view provider for `ethos.chat` (`src/panel.ts`). |
| `AcpBridge` | class | Spawns `<cliPath> acp` and talks JSON-RPC (`src/bridge.ts`). |
| `decideFinalize` | function | Decides what the webview does with a turn's final text. |

VS Code contributions in `package.json` (command ids, not source symbols): `ethos.newSession`, `ethos.abort`, setting `ethos.cliPath` (default `ethos`, machine-scoped). Scripts: `build`, `watch` (tsup, CJS).

## Seam

Layer: not seen by archcheck. `architecture.config.ts` states that apps/vscode-extension is excluded from the root tsconfig archcheck reads, so no layer rule applies to it. It reaches Ethos only through the `ethos acp` process (`apps/acp-server`), not by importing workspace packages.

## Testing

```
pnpm vitest run apps/vscode-extension
```

Pinning test: `src/__tests__/finalize.test.ts` holds that a `returnDirect` answer with no preceding `text_delta` still reaches the webview, and that the webview script carries exactly `decideFinalize`'s source.
