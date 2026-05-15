---
title: "Why oRPC"
description: "The reasoning behind choosing oRPC as the RPC framework for the Ethos control plane, and what that choice means for SDK consumers."
kind: explanation
audience: developer
slug: why-orpc
updated: 2026-05-13
---

## Context

The Ethos web control plane needs a typed RPC layer between the server (`apps/web-api`) and every client that consumes it: the first-party web UI (`apps/web`), the published SDK (`packages/sdk`), and any external Mission Control dashboard a third party builds. The framework options at the time of the decision were GraphQL, tRPC, REST-with-OpenAPI-codegen, and oRPC.

This page explains why oRPC won, and what the choice costs and buys.

## Why not GraphQL

GraphQL solves a real problem — frontend teams that need to ask for exactly the fields they want across a graph of entities. Ethos has neither the graph nor the team.

The contract surface is procedural: `sessions.list`, `chat.send`, `memory.write`. There is no entity graph to traverse. The request/response shapes are small enough that over-fetching is not a performance concern. GraphQL would add a resolver layer, a schema definition language, and a code-generation pipeline for zero practical gain.

The server is also a single-user local process. GraphQL's strengths — federated subgraphs, field-level authorization, batched DataLoader queries — assume a multi-tenant service with multiple backend teams. That is not Ethos.

## Why not tRPC

tRPC is the closest cousin. It shares the same thesis: define procedures in TypeScript, infer types on both sides, skip code generation.

The difference is the contract boundary. tRPC's types flow through the TypeScript compiler — the server's router type is imported directly by the client. This works when both sides live in the same monorepo and share a `tsconfig`. It breaks when the client is a published npm package consumed by strangers. The SDK consumer cannot import the server's router type; they need a standalone contract package they can depend on.

oRPC separates the contract (`@orpc/contract`) from the server implementation (`@orpc/server`) and the client (`@orpc/client`). The contract is a plain TypeScript module with Zod schemas. It can be published as its own package (`@ethosagent/web-contracts`) and depended on independently. The server calls `implement(contract)` against it; the client calls `createORPCClient(link)` typed as `ContractRouterClient<typeof contract>`. Both sides fail to compile if the shapes drift — the same guarantee tRPC provides, but across a package boundary.

## Why not REST-with-OpenAPI

A hand-written REST API with OpenAPI code generation is viable. The Ethos server already serves an auto-generated OpenAPI spec at `/openapi/spec.json` and a Scalar reference UI at `/openapi/`. But these are derived artifacts, not the source of truth.

The problem with REST-first is the contract direction. You either write the OpenAPI spec and generate server stubs (spec-first), or write the handlers and generate the spec (code-first). Spec-first means maintaining a YAML file that drifts from the implementation. Code-first means the spec is a byproduct that no one reviews.

oRPC sidesteps this: the Zod schemas in `packages/web-contracts/src/router.ts` are the single source of truth. The OpenAPI spec is generated from them automatically via `@orpc/openapi`. The REST-shaped endpoints at `/openapi/sessions/list` hit the same service layer and validate through the same Zod schemas — contract drift between the RPC and OpenAPI surfaces is structurally impossible.

## What oRPC buys

**Type safety from contract to client.** `EthosClient.rpc` is typed as `ContractRouterClient<Contract>`. Calling `client.rpc.sessions.list({})` is fully type-checked. If the server adds a required field, the SDK consumer's build breaks before they ship. The compiler catches schema drift — not integration tests, not runtime errors, the compiler.

**Auto-generated OpenAPI for free.** Third parties who prefer REST get a documented API without anyone maintaining a spec file. The server mounts `@orpc/openapi` and serves `/openapi/spec.json` (a valid OpenAPI 3.x document covering every contract namespace) and `/openapi/` (a Scalar reference UI). REST-shaped endpoints at `/openapi/sessions/list` hit the same service layer and validate through the same Zod schemas. The OpenAPI surface tests in `apps/web-api/src/__tests__/routes/openapi.test.ts` verify all three: spec generation, Scalar UI rendering, and REST-shaped endpoint routing.

**Thin SDK wrapper.** The entire `EthosClient` class in `packages/sdk/src/client.ts` is under 40 lines. It constructs an `RPCLink` pointed at `${baseUrl}/rpc`, passes it to `createORPCClient`, and exposes the result as `this.rpc`. There is no hand-written method-per-endpoint boilerplate. When a new namespace lands in the contract, SDK consumers get it immediately — no SDK release required.

**Transport abstraction via RPCLink.** The client delegates all HTTP concerns to `RPCLink` from `@orpc/client/fetch`. This is a seam: the SDK's public API (`client.rpc.sessions.list(...)`) does not encode HTTP. A future `InProcessLink` could dispatch directly to the service layer without serialization. See [The transport seam](transport-seam.md) for the design direction.

**Validation at the boundary, not in the handler.** Because input and output schemas are Zod objects declared in the contract, validation happens automatically before the handler runs and after it returns. Handlers receive typed, validated input — they never parse or check shapes manually. This eliminates the class of bugs where a handler accepts malformed input and produces a confusing error deep in the service layer.

## What oRPC costs

**Ecosystem maturity.** oRPC is younger than tRPC and GraphQL. Tooling (devtools, middleware ecosystem, community recipes) is thinner. The bet is that the contract-first model is worth the smaller ecosystem.

**Learning curve for contributors.** Developers familiar with tRPC or Express need to learn the `oc.input().output()` contract DSL and the `implement(contract)` server wiring. The surface is small — the full contract lives in one file (`router.ts`) — but it is unfamiliar.

**Zod coupling.** The contract schemas are Zod objects. If Zod's API changes (it did between v3 and v4), the contract schemas need migration. This is manageable — the schemas are pure data definitions with no runtime logic — but it is a dependency to track.

## The contract file in practice

The entire contract lives in one file: `packages/web-contracts/src/router.ts`. Each namespace is a plain object of `oc.input(ZodSchema).output(ZodSchema)` declarations. The file is long (800+ lines at the time of writing) but flat — no inheritance, no middleware chains, no decorators. A developer who wants to understand the API reads this one file.

The comment block at the top of `router.ts` summarizes the architecture:

> `apps/web-api` (server) calls `implement(contract)` against this.
> `apps/web` (client) calls `createORPCClient(link)` typed as
> `ContractRouterClient<typeof contract>`. Both ends fail to compile if the
> shapes drift.

This is the core value proposition: one file defines the contract, two consumers compile against it, drift is a compile error.

## Consequences for SDK consumers

A dashboard builder who depends on `@ethosagent/sdk` gets:

1. **Type-checked RPC calls** — `client.rpc.personalities.get({ id })` returns a typed `{ personality, ethosMd }`. No manual response parsing.
2. **Stability guarantees tied to the contract** — namespaces tagged `@stable` in `router.ts` promise additive-only changes. See [Stability tiers](stability-tiers.md).
3. **OpenAPI as an escape hatch** — if the SDK's oRPC client does not fit their stack (e.g., they are building in Python), the same endpoints are reachable as plain REST via `/openapi/`.
4. **No code generation step** — unlike GraphQL or OpenAPI-codegen workflows, there is no build-time generation. Types flow through the TypeScript compiler directly.
5. **Dual auth support** — the same contract serves cookie-authenticated web UIs and bearer-token-authenticated external dashboards. The SDK constructor accepts either a `baseUrl` alone (cookie mode) or a `baseUrl` plus `apiKey` (bearer mode). The contract does not change between auth modes — only the available namespaces differ (experimental namespaces are cookie-only).
