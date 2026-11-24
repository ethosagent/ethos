# @ethosagent/execution-node

Laptop-as-a-tool-node for a server Ethos. This package holds both halves of the
node protocol:

- Server side: the hub that tracks connected laptops and proxies `node_*` tool
  calls to them.
- Laptop side: the client that dials out, and `NodeGuard`, the admission check
  that decides whether a call from the server may run on the laptop.

The wire format (`src/frames.ts`) is versioned JSON text frames, validated by
hand-written decoders with no `as` casts on wire data.

## Dependency rule

Only `@ethosagent/types`, `@ethosagent/storage-fs` and `ws`. `@ethosagent/core`
is a dev dependency for tests. Wiring composes the base tools; an extension
never imports a sibling extension.

## Tier

Tier 1 in `.architecture-state.yaml`: it sits on a trust boundary, because the
laptop runs what a remote server asks. `NodeGuard` (`src/node-guard.ts`) is that
boundary's admission check, pinned by `src/__tests__/node-guard.test.ts`.

## Plan

See `plan/phases/laptop-tool-node.md` and
`plan/briefs/laptop-tool-node-verification.md`.
