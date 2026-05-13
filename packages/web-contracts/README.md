# @ethosagent/web-contracts

Typed [oRPC](https://orpc.dev) contract and [Zod](https://zod.dev) schemas for the Ethos web API.

This package defines the wire-format schemas and typed contract that both the Ethos web API server and `@ethosagent/sdk` consume. Use it directly if you need schema validation or want to build a custom client.

## Installation

```bash
npm install @ethosagent/web-contracts
```

## Usage

```ts
import { contract, SessionSchema, PersonalitySchema } from '@ethosagent/web-contracts';

// Use Zod schemas for validation
const session = SessionSchema.parse(rawData);

// Use the oRPC contract for typed API definitions
// The contract object defines every route with input/output schemas
```

## What's included

- **Zod schemas** for all API wire types (sessions, personalities, kanban, memory, etc.)
- **oRPC contract** defining every API route with typed inputs and outputs
- **TypeScript types** inferred from schemas via `z.infer`

## Related

- [`@ethosagent/sdk`](https://www.npmjs.com/package/@ethosagent/sdk) -- high-level client SDK built on these contracts
- [Ethos documentation](https://github.com/ethosagent/ethos)
