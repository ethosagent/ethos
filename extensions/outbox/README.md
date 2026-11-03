# @ethosagent/outbox

## Purpose

The personality approval outbox. A gated `send_message` proposes a publication instead of sending it; a human approves exactly one revision of one text to one destination, and only then can the gateway dispatcher claim and deliver it. This package holds the durable SQLite store, the lifecycle state machine and the content hash that binds an approval; it knows nothing about adapters, personalities or tools, which wire it in from above.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteOutboxStore` | class | `OutboxStore` over `@ethosagent/sqlite`; every state change is a conditional `UPDATE`. |
| `OutboxStore` | type | Store interface: propose, bound approve, edit, reject, revoke, retry, claim. |
| `OutboxService` | class | Lifecycle rules, legality checks and the audit trail of human decisions. |
| `OutboxServiceOptions` | type | Options for `OutboxService`, including the optional audit sink. |
| `OutboxObservability` | type | Structural audit sink (`recordSafetyApproval`); no import from wiring. |
| `OUTBOX_AUDIT_CODES` | const | The audit code written for each of the five human decisions. |
| `LEGAL_FROM` | const | Which `OutboxState`s each `OutboxAction` may start from. |
| `OutboxState` | type | Lifecycle state of one publication. |
| `ACTIVE_STATES` | const | States that count as an open item for repeat-proposal collapsing. |
| `OutboxItem` | type | One publication row. |
| `OutboxRevision` | type | One immutable text revision. |
| `ReviewReceipt` | type | Outcome of an automated reviewer pass. |
| `ReviewVerdict` | type | `pass`, `fail`, `unclear` or `unavailable`. |
| `ProposeInput` | type | Input to propose a publication. |
| `ProposeResult` | type | Result of a proposal. |
| `OutboxResult` | type | Success or typed failure from a service call. |
| `OutboxErrorCode` | type | `not_found`, `conflict`, `illegal_transition`, `binding_mismatch`. |
| `computeContentHash` | function | Hash binding text, destination, thread and revision. |
| `canonicalizeContent` | function | Canonical byte form fed to the hash. |
| `ContentHashInput` | type | Input to the hash. |
| `PENDING_EXPIRY_MS` | const | Seven days for an unreviewed item. |
| `APPROVAL_VALIDITY_MS` | const | 24 hours for an approved, undelivered item. |
| `STALE_THRESHOLD_MS` | const | Ten minutes before a review or claim is treated as abandoned. |

Main entry points; the remaining input and report types (`ApproveInput`, `EditInput`, `RejectInput`, `DecisionInput`, `BoundPublication`, `ExpiryReport`, `OutboxAction`, `OutboxDecision`) are exported alongside. Only the `.` entry exists in `package.json` `exports`.

## Seam

Layer `extensions`. It imports nothing from `@ethosagent/types`; the audit sink is declared structurally so the package never points up the layer model (ARCHITECTURE.md §II). `SQLiteOutboxStore` takes the raw-`node:fs` carve-out for a SQLite path, listed in `.claude/rules/fs-carveouts-sqlite.md`, because its approve and claim are conditional updates whose affected-row count is the answer. Durability posture is `synchronous = FULL`, pinned by the `durability posture` test in `src/__tests__/store.test.ts`; `.claude/rules/sqlite-durability.md` gives the reason.

## Testing

```
pnpm vitest run extensions/outbox
```

- `src/__tests__/hash.test.ts`: canonical key order, the `v:1` golden vector, every bound field changes the hash, text is byte-exact.
- `src/__tests__/store.test.ts`: propose and repeat-proposal collapsing, bound approve touches zero rows on a stale revision or hash, edit voids a prior approval, `synchronous = FULL`.
- `src/__tests__/service.test.ts`: legality table across every action and state, stale approve returns conflict, edit voids approval, binding mismatch fails the item, one audit row per decision with the binding but never the text, fixed expiry windows.
