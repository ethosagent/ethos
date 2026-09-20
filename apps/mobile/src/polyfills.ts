// The one module that installs globals (R8), imported first by app/_layout.tsx.
// Hermes on RN 0.86 has no `crypto` and no `AbortSignal.timeout`; Expo's own
// globals already cover TextEncoder/TextDecoder, ReadableStream, URL and
// structuredClone. No `Intl.RelativeTimeFormat` polyfill: nothing the Phase-1
// screens import calls it (chat-state has no `formatRelative` yet — T5).
import { getRandomValues, randomUUID } from 'expo-crypto';
import { abortSignalTimeout } from './lib/abort';

const g = globalThis as { crypto?: Partial<Crypto> };
g.crypto ??= {};
g.crypto.randomUUID ??= randomUUID as Crypto['randomUUID'];
g.crypto.getRandomValues ??= getRandomValues as Crypto['getRandomValues'];
// `@ethosagent/sdk`'s probeConnection calls AbortSignal.timeout directly.
AbortSignal.timeout ??= abortSignalTimeout;
