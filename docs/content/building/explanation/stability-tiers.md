---
title: "Stability tiers"
description: "What the @stable and @experimental tags on contract namespaces promise, and how CI enforces them."
kind: explanation
audience: developer
slug: stability-tiers
updated: 2026-05-13
---

## Context

The contract in `packages/web-contracts/src/router.ts` defines every RPC namespace the web API serves. Each namespace carries a JSDoc tag — either `@stable` or `@experimental` — that communicates a compatibility promise to SDK consumers and external dashboard builders.

The tags are not decorative. They gate what changes require a major version bump and what changes can land in a patch.

## What @stable promises

A namespace tagged `@stable v1` makes three commitments:

1. **No removal.** Every procedure in the namespace today will exist in every future `1.x` release. `sessions.list`, `sessions.get`, `sessions.fork`, `sessions.delete`, `sessions.update` — none of these can be removed without bumping to `2.0`.

2. **No rename.** Procedure names are part of the public API. Renaming `sessions.fork` to `sessions.clone` is a breaking change. It does not happen within a major version.

3. **Additive only.** New procedures can be added to a stable namespace. Adding `sessions.archive` to the `sessions` namespace is a non-breaking change — existing SDK consumers do not call it, so their code is unaffected. New optional fields on existing input/output schemas are also additive and non-breaking.

The current stable namespaces are: `sessions`, `personalities` (read-only at v1), `chat`, `memory`, and `meta`.

## What @experimental warns

A namespace tagged `@experimental` makes no compatibility promise. Procedures can be renamed, removed, or have their input/output schemas changed in any release — including patches.

The current experimental namespaces include: `tools`, `clarify`, `onboarding`, `config`, `cron`, `skills`, `evolver`, `mesh`, `plugins`, `platforms`, `batch`, `eval`, `kanban`, and `apiKeys`.

A dashboard builder who depends on an experimental namespace should pin the SDK version and expect migration work when upgrading. The experimental tag is a signal to consumers: "this works, but the shape is not settled."

## How fields get added

Adding a field to a stable namespace follows a specific protocol:

**New optional input field.** Non-breaking. The server accepts requests that omit it. Existing SDK consumers send no value; the server uses its default. Example: adding an optional `archived: z.boolean().optional()` to `SessionListInput`.

**New required input field.** Breaking. Every caller must send the new field or their requests fail validation. This forces a major version bump. The practice is to avoid required input fields in stable namespaces after v1 — use optional with a server-side default instead.

**New output field.** Non-breaking. Existing SDK consumers receive the new field and ignore it (TypeScript structural typing means extra fields do not cause type errors). Example: adding `messageCount: z.number()` to `SessionSchema`.

**Removing or renaming a field.** Breaking. This is the scenario the stable tag explicitly forbids within a major version.

## What forces a major version bump

Four things:

1. Removing a procedure from a stable namespace.
2. Renaming a procedure in a stable namespace.
3. Adding a required input field to a stable procedure.
4. Changing the type of an existing field in a stable procedure (e.g., `string` to `number`).

Everything else — new procedures, new namespaces, new optional fields, changes to experimental namespaces — is non-breaking.

## The snapshot test CI gate

The stability promise is enforced mechanically by `packages/web-contracts/src/__tests__/stable-surface-snapshot.test.ts`. The test maintains a `STABLE_SURFACE` record that lists every stable namespace and its expected procedures:

```typescript
const STABLE_SURFACE: Record<string, string[]> = {
  sessions: ['list', 'get', 'fork', 'delete', 'update'],
  chat: ['send', 'abort'],
  personalities: ['list', 'get', 'characterSheet'],
  memory: ['list', 'get', 'write'],
  meta: ['capabilities'],
};
```

For each namespace, the test iterates over the expected procedures and asserts they exist in the actual contract using `toContain`. This means:

- **Removing a procedure fails CI.** If someone deletes `sessions.fork` from the contract, the test fails because `actualKeys` no longer contains `'fork'`.
- **Renaming a procedure fails CI.** Renaming is removal plus addition — the old name disappears, the test catches it.
- **Adding a procedure passes CI.** The test uses `toContain`, not exact equality. Adding `sessions.archive` does not break the test because `actualKeys` still contains all the expected names.

The test is the mechanical enforcement of the additive-only promise. A developer who wants to remove a stable procedure must first update `STABLE_SURFACE` — and that change is the signal to reviewers that a breaking change is being proposed.

## The dual-auth scope map

The stability tiers also interact with the API key auth system. The `SCOPE_MAP` in `apps/web-api/src/middleware/dual-auth.ts` maps stable namespace procedures to named scopes (`sessions:read`, `chat:send`, `memory:write`, etc.). Experimental namespaces are not in the scope map — they are accessible only via cookie auth (the web UI) and explicitly rejected for bearer token auth.

This means external Mission Controls that authenticate via API key can only call stable procedures (plus any experimental namespaces that are explicitly added to the scope map in the future). The stability tier determines not just the compatibility promise but also the auth surface.

## Promoting experimental to stable

When an experimental namespace's shape settles, it can be promoted to stable by:

1. Changing the JSDoc tag from `@experimental` to `@stable`.
2. Adding the namespace and its procedures to `STABLE_SURFACE` in the snapshot test.
3. Adding the namespace's procedures to `SCOPE_MAP` in `dual-auth.ts` (to enable API key access).
4. Documenting the promotion in the changelog.

The promotion is a one-way door. Once stable, the additive-only promise applies and the CI gate enforces it.
