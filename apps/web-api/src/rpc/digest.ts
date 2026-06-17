import { os } from './context';

// Thin RPC shell for the digest namespace — `latest` reads the newest digest;
// `generate` builds + writes the current ISO week's digest on demand.

export const digestRouter = {
  latest: os.digest.latest.handler(({ context }) => context.digest.latest()),
  generate: os.digest.generate.handler(({ context }) => context.digest.generate()),
};
