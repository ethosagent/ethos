import { os } from './context';

// Approval leases (reach-and-containment 3b) — the Settings → Approvals list.
// A lease is granted through `tools.approve` with scope `lease-1h`; the state
// and the call-time check live in `ApprovalsService`.

export const approvalsRouter = {
  leases: {
    list: os.approvals.leases.list.handler(async ({ context }) => ({
      leases: await context.approvals.listActiveLeases(),
    })),

    revoke: os.approvals.leases.revoke.handler(async ({ input, context }) => {
      await context.approvals.revokeLease(input.id);
      return { ok: true as const };
    }),
  },
};
