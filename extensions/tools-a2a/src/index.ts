// @ethosagent/tools-a2a — the OUTBOUND A2A tool (plan §7 Phase 7 exposure).
//
// `a2a_send` lets a personality call a PEER agent. It is a thin surface over
// `@ethosagent/a2a`'s `A2aOutboundClient`: resolve MY identity + signing key for
// the ACTIVE personality, connect (fetch + verify the peer's card, handshake for
// a token), then `message/send`. When this turn is servicing an inbound A2A task
// the ambient `ctx.a2aDelegation` frame is passed straight through so the onward
// call is depth+fan-out contained by the runtime (P8) — the tool never re-implements
// any of that trust logic.
//
// Layer purity: imports ONLY `@ethosagent/types` + `@ethosagent/a2a`. No core, no apps.

import { A2aClientError, A2aOutboundClient, A2aOutboundError } from '@ethosagent/a2a';
import type {
  A2aIdentityProvider,
  SecretsResolver,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';

export interface A2aToolDeps {
  /** Projects the active personality into a signed AgentCard (MY card). */
  identity: A2aIdentityProvider;
  /** Resolves MY Ed25519 signing key from `a2a/<personalityId>/private-key`. */
  secrets: SecretsResolver;
  /** Injectable outbound client (tests); defaults to a fresh `A2aOutboundClient`. */
  client?: A2aOutboundClient;
  /**
   * Allow a personality to call its OWN agent over A2A (self-loop). Default
   * false — set via `ETHOS_A2A_SELF_LOOP=1` at the wiring layer (plan §14).
   */
  allowSelfLoop?: boolean;
}

interface A2aSendArgs {
  peer_url: string;
  fingerprint?: string;
  skill: string;
  message: string;
  mode?: 'sync' | 'async';
}

function parseArgs(args: unknown): A2aSendArgs | null {
  if (args === null || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (typeof a.peer_url !== 'string' || typeof a.skill !== 'string') return null;
  if (typeof a.message !== 'string') return null;
  const mode = a.mode === 'async' ? 'async' : a.mode === 'sync' ? 'sync' : undefined;
  return {
    peer_url: a.peer_url,
    skill: a.skill,
    message: a.message,
    ...(typeof a.fingerprint === 'string' ? { fingerprint: a.fingerprint } : {}),
    ...(mode ? { mode } : {}),
  };
}

function makeA2aSendTool(deps: A2aToolDeps): Tool {
  const client = deps.client ?? new A2aOutboundClient();

  return {
    name: 'a2a_send',
    description:
      "Send a message to a peer agent over A2A. Give the peer's well-known Agent Card URL, the skill to invoke, and the message. Returns the peer's reply (sync) or a submission handle (async). Peering, allowlist, and tokens are handled by the runtime — you do not manage them.",
    toolset: 'a2a',
    maxResultChars: 20_000,
    capabilities: {
      // Calls an arbitrary peer-supplied URL; the outbound client handles card
      // verification + the auth handshake. Broad host reach mirrors web_extract.
      network: { allowedHosts: ['*'] },
    },
    // The peer's reply is adversary-controlled — another agent authored it.
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        peer_url: {
          type: 'string',
          description: "The peer's /.well-known/agent-card.json URL.",
        },
        fingerprint: {
          type: 'string',
          description:
            'Optional out-of-band key fingerprint (the trust anchor from peering). When set, the fetched card must match it.',
        },
        skill: { type: 'string', description: 'The peer skill/capability to invoke.' },
        message: { type: 'string', description: 'The message to send to the peer.' },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description:
            "Delivery mode. 'sync' waits for the reply (default); 'async' submits and returns a handle.",
        },
      },
      required: ['peer_url', 'skill', 'message'],
    },
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = parseArgs(rawArgs);
      if (!args) {
        return {
          ok: false,
          error: 'peer_url, skill, and message are required strings',
          code: 'input_invalid',
        };
      }

      const personalityId = ctx.personalityId;
      if (!personalityId) {
        return {
          ok: false,
          error: 'No active personality — a2a_send needs a personality identity to sign as',
          code: 'input_invalid',
        };
      }

      const myCard = await deps.identity.getIdentity(personalityId, 'internal');
      const pem = await deps.secrets.get(`a2a/${personalityId}/private-key`);
      if (!pem) {
        return {
          ok: false,
          error: 'A2A signing key not configured for this personality',
          code: 'not_available',
        };
      }

      try {
        const session = await client.connect({
          wellKnownUrl: args.peer_url,
          ...(args.fingerprint ? { expectedFingerprint: args.fingerprint } : {}),
          myCard,
          myPrivateKeyPem: pem,
          ...(deps.allowSelfLoop ? { allowSelfLoop: true } : {}),
        });

        // Ambient inbound trace (P8) — already the {traceId, depth, reserveOutbound}
        // shape the client expects. Absent → a fresh top-level call.
        const delegation = ctx.a2aDelegation;

        const result = await client.sendMessage({
          session,
          myPrivateKeyPem: pem,
          skill: args.skill,
          message: args.message,
          ...(args.mode ? { mode: args.mode } : {}),
          ...(delegation ? { delegation } : {}),
        });

        if (!result.ok) {
          return {
            ok: false,
            error: `${result.code}: ${result.message}`,
            code: 'execution_failed',
          };
        }

        if (result.mode === 'async') {
          return {
            ok: true,
            value: `Submitted to peer (async). Task ${result.taskId} is ${result.status}.`,
            structured: { ...result },
          };
        }

        return {
          ok: true,
          value: result.text,
          structured: { ...result },
        };
      } catch (err) {
        if (err instanceof A2aOutboundError) {
          if (err.code === 'fanout_exhausted') {
            return {
              ok: false,
              error:
                'A2A fan-out budget exhausted for this task — refusing further outbound calls (delegation containment).',
              code: 'execution_failed',
            };
          }
          if (err.code === 'self_loop_forbidden') {
            return {
              ok: false,
              error:
                'A2A self-loop is disabled (set ETHOS_A2A_SELF_LOOP=1 to allow calling your own agent).',
              code: 'execution_failed',
            };
          }
          return { ok: false, error: err.message, code: 'execution_failed' };
        }
        if (err instanceof A2aClientError) {
          return { ok: false, error: `${err.code}: ${err.message}`, code: 'execution_failed' };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

/** Build the outbound A2A toolset. Register only when A2A is enabled (opt-in). */
export function createA2aTools(deps: A2aToolDeps): Tool[] {
  return [makeA2aSendTool(deps)];
}
