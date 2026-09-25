import { os } from './context';

// Usage namespace — spend and tokens over a window, the aggregation `ethos
// usage` prints (`UsageService`, plan openclaw-2026.9.6-gaps U3). Read-only;
// mapped to `sessions:read` in SCOPE_MAP because every figure is derived from
// session message rows.

export const usageRouter = {
  summary: os.usage.summary.handler(({ input, context }) =>
    context.usage.summary({ windowMs: input.windowMs, ...(input.by ? { by: input.by } : {}) }),
  ),
};
