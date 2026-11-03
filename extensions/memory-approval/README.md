# @ethosagent/memory-approval

## Purpose

Approve-before-store for memory. `PendingMemoryGate` decorates a memory provider so writes from gated sources (capture and dream, or every source) are parked in a pending queue instead of reaching the inner provider; approve replays them through history with the original source and approver. It also keeps tombstones of rejected facts so they are not proposed again.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `PendingMemoryGate` | class | Memory decorator that parks gated `sync` updates and passes everything else through. |
| `withPendingGate` | function | Wraps a provider in the gate. |
| `WithPendingGateOptions` | interface | `store`, `mode` and baked-in `source`. |
| `isGated` | function | Whether a memory source is gated under a mode. |
| `PendingMemoryStore` | class | The pending queue: propose, approve, reject, expiry, `applyPauseOffset`. |
| `PendingMemoryStoreOptions` | interface | Storage, data dir, tombstones, apply callback, cap, TTL, evidence and `autoPromote`. |
| `TombstoneStore` | class | Records rejected fact hashes. |
| `TombstoneStoreOptions` | interface | Tombstone store options. |
| `MemoryApprovalMode` | type | `off`, `automated` or `all`. |
| `PendingEntry` | interface | One queued candidate. |
| `ProposeInput` | interface | Input to propose a candidate. |
| `TombstoneRecord` | interface | One tombstone. |
| `ApplyFn` | type | Callback that replays an approved entry. |
| `PendingGateObservability` | interface | `onCapExceeded` hook when the cap drops an entry. |
| `MAX_EVIDENCE_SESSIONS` | const | Cap on recorded recurrence sessions per entry. |
| `EVIDENCE_APPROVER` | const | Approver label for evidence-based promotion. |
| `PENDING_FILE` | const | Queue file name. |
| `TOMBSTONE_FILE` | const | Tombstone file name. |
| `scopeDir` | function | Directory for a memory scope. |

## Seam

`PendingMemoryGate` implements `MemoryProvider` and `GlobalMemoryStore` from `@ethosagent/types` (`implements MemoryProvider, GlobalMemoryStore` in `src/gate.ts`), composing over `@ethosagent/memory-history`. Contract rules in `.claude/rules/memory.md`. Archcheck layer: `extensions`.

Pinned by `src/__tests__/gate.test.ts` (mode `off` is a pure pass-through; a gated dream turn is parked and not written) and `src/__tests__/store.test.ts` (reject tombstones the fact hash; approve replays through history with the original source and approver).

## Testing

```
pnpm vitest run extensions/memory-approval
```

Pinning tests in `src/__tests__/`: `src/__tests__/gate.test.ts` (gating by mode), `src/__tests__/store.test.ts` (park, approve, reject, cap, expiry), `src/__tests__/evidence.test.ts` (recurrence evidence merges by fact hash, capped sessions, no auto-approve without `autoPromote`), `src/__tests__/pause-offset.test.ts` (a host pause does not auto-reject a candidate that is under 30 owner-visible days old).
