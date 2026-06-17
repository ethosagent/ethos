import { os } from './context';

// Thin RPC shell for the digest namespace — a single read-only service call.

export const digestRouter = {
  latest: os.digest.latest.handler(({ context }) => context.digest.latest()),
};
