import type { A2aPeeringService } from '@ethosagent/wiring';
import { A2aPeeringError } from '@ethosagent/wiring';
import { ORPCError } from '@orpc/server';
import type { A2aControl } from '../routes/route-module';
import { os } from './context';

// A2A peering namespace — thin RPC wrappers over the wiring `A2aPeeringService`
// plus the runtime enable/disable control. The ADMIN surface: rides the same
// cookie/bearer `/rpc` auth as the other management namespaces, distinct from
// the public peer-facing `/a2a` endpoints. Trust invariants live in the shared
// service — handlers only marshal I/O and map errors (§6). `a2aPeering` /
// `a2aControl` are threaded on by `serve` only; absent elsewhere → every
// procedure returns NOT_AVAILABLE (503) instead of dereferencing undefined.

const notAvailable = () =>
  new ORPCError('NOT_AVAILABLE', { status: 503, message: 'A2A is not available on this server' });

function requirePeering(peering: A2aPeeringService | undefined): A2aPeeringService {
  if (!peering) throw notAvailable();
  return peering;
}

function requireControl(control: A2aControl | undefined): A2aControl {
  if (!control) throw notAvailable();
  return control;
}

// Map an A2aPeeringError to a typed oRPC error (no raw stack — service messages
// are clean strings). Non-peering errors propagate; the `/rpc` interceptor +
// error-envelope redact internals for those.
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof A2aPeeringError) {
      // fingerprint_mismatch: a valid signature over the WRONG key is still a
      // stranger — a client-side validation failure surfaced on the verify step.
      if (err.code === 'fingerprint_mismatch')
        throw new ORPCError('FINGERPRINT_MISMATCH', { status: 400, message: err.message });
      if (err.code === 'unknown_personality')
        throw new ORPCError('NOT_FOUND', { status: 404, message: err.message });
      // fetch_failed / invalid_card — upstream peer card unreachable or untrusted.
      throw new ORPCError('A2A_UPSTREAM_ERROR', { status: 502, message: err.message });
    }
    throw err;
  }
}

export const a2aRouter = {
  settings: {
    get: os.a2a.settings.get.handler(async ({ context }) => ({
      enabled: requireControl(context.a2aControl).isEnabled(),
    })),

    set: os.a2a.settings.set.handler(async ({ input, context }) => {
      const control = requireControl(context.a2aControl);
      await control.setEnabled(input.enabled);
      return { enabled: control.isEnabled() };
    }),
  },

  identity: os.a2a.identity.handler(async ({ input, context }) =>
    guard(() => requirePeering(context.a2aPeering).identity(input.personalityId)),
  ),

  peers: {
    list: os.a2a.peers.list.handler(async ({ input, context }) =>
      guard(() => requirePeering(context.a2aPeering).listPeers(input.personalityId)),
    ),

    preview: os.a2a.peers.preview.handler(async ({ input, context }) =>
      guard(async () => {
        // Return ONLY the verify-step fields — not the whole signed card.
        const { card, fingerprint } = await requirePeering(context.a2aPeering).previewPeer(
          input.url,
        );
        return { fingerprint, name: card.name, description: card.description };
      }),
    ),

    add: os.a2a.peers.add.handler(async ({ input, context }) =>
      guard(() =>
        requirePeering(context.a2aPeering).addPeer(input.personalityId, {
          url: input.url,
          expectedFingerprint: input.expectedFingerprint,
          ...(input.label !== undefined ? { label: input.label } : {}),
        }),
      ),
    ),

    setEnabled: os.a2a.peers.setEnabled.handler(async ({ input, context }) =>
      guard(async () => {
        await requirePeering(context.a2aPeering).setEnabled(
          input.personalityId,
          input.fingerprint,
          input.enabled,
        );
        return { ok: true as const };
      }),
    ),

    remove: os.a2a.peers.remove.handler(async ({ input, context }) =>
      guard(async () => {
        await requirePeering(context.a2aPeering).removePeer(input.personalityId, input.fingerprint);
        return { ok: true as const };
      }),
    ),
  },

  skills: {
    listExposable: os.a2a.skills.listExposable.handler(async ({ input, context }) =>
      guard(() => requirePeering(context.a2aPeering).exposableSkills(input.personalityId)),
    ),
  },
};
