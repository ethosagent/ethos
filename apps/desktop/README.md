# @ethosagent/desktop

## Purpose

The Ethos desktop app, an Electron application built with electron-vite. The main process starts or connects to a web-api backend (embedded local, or remote), loads the web SPA over HTTP, and adds tray, global shortcut, notifications, auto-update, call capture and a voice satellite.

## Public surface

This is a private app (no library exports, no binary). Entry points:

| Export | Kind | One line |
|---|---|---|
| `registerIpcHandlers` | function | Registers every `ipcMain.handle` channel (`src/main/ipc.ts`). |
| `IPC_CHANNELS` | const | The renderer/main IPC channel names (`src/shared/ipc-contract.ts`). |
| `startBackend` | function | Starts the embedded backend (`src/main/backend.ts`). |
| `initAutoUpdater` | function | Wires electron-updater (`src/main/auto-update.ts`). |

Main entry: `src/main/index.ts` (package.json `main` is `dist/main/index.js`). Scripts: `dev` (`electron-vite dev`), `build`, `package` (`electron-builder`), `typecheck`.

## Seam

Layer: not seen by archcheck. `architecture.config.ts` states apps/desktop is excluded from the root tsconfig archcheck reads, so no layer rule applies.

## Testing

```
pnpm vitest run apps/desktop
```

Pinning tests (`src/main/__tests__/`):

- `spa-csp.test.ts`: Content-Security-Policy for the SPA loaded over HTTP.
- `serve.test.ts`: in-process backend wiring and secret refs.
- `backend.test.ts`, `connection.test.ts`: backend start and local/remote connection mode.
- `runtime-shutdown.test.ts`, `quit-shutdown.test.ts`: orderly shutdown.
- `mcp-export-seams.test.ts`: the MCP export section's recent denials.
- `call-capture*.test.ts`, `satellite.test.ts`, `tray.test.ts`, `startup-mode.test.ts`, `gateway-control.test.ts`, `onboarding-*.test.ts`, `learning-replay.test.ts`: the matching main-process modules.
