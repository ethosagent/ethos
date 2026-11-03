# @ethosagent/tui

## Purpose

The interactive terminal UI for Ethos, built on Ink and React. `runTUI` takes an `AgentLoop` and renders chat, approval and clarify modals, model and session pickers, and an execution timeline. The `ethos` CLI calls `runTUI` in `apps/ethos/src/commands/chat.ts` and `runSetupWizard` in `commands/setup.ts`.

## Public surface

This is an app (private, no binary). Entry points via package.json `exports`:

| Export | Kind | One line |
|---|---|---|
| `runTUI` | function | Renders the TUI for an `AgentLoop`. Subpath `.` (`src/index.ts`). |
| `TUIOptions` | interface | Options for `runTUI`. |
| `AgentBridge` | class | Re-exported from `@ethosagent/agent-bridge`. |
| `ExternalSlashCommands` | type | Slash commands injected by the host. |
| `SplashInventory` | type | Data for the splash screen. |
| `RebuiltLoop` | type | Result of rebuilding the loop on a switch. |
| `runSetupWizard` | function | Setup wizard. Subpath `@ethosagent/tui/setup` (`src/setup/index.ts`). |
| `RunSetupWizardOpts` | interface | Options for `runSetupWizard`. |

## Seam

Layer: apps; `apps/tui/src/index.ts` and `apps/tui/src/setup/index.ts` are `app-entry` modules (`app-entry-modules-compose`). Law 5 (apps do not bypass wiring), enforced by archcheck `l5-apps-through-wiring`. UI decisions follow `.claude/rules/ui-design.md`, which matches `apps/tui/**`.

## Testing

```
pnpm vitest run apps/tui
```

Pinning tests (`src/__tests__/`):

- `approval-modal.test.ts`: approval modal key handling inside React `act`.
- `budget-halt.test.ts`: a session budget stop renders the cap and `/budget reset`.
- `loop-switch.test.ts`: the previous runtime is retired only after its running turn finishes.
- `help.test.ts`: help text is the slash-command table filtered by `tui`.
- `credential-prompt.test.ts`, `event-render.test.ts`, `format-cost.test.ts`, `personality-switch.test.ts`, `return-direct-answer.test.ts`, `startup-notices.test.ts`: rendering and startup behaviour.
