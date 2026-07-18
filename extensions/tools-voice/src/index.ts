// @ethosagent/tools-voice — the outbound telephony `call` tool
// (plan/phases/gap-voice-realtime.md §4 Phase C).
//
// `call` places an outbound PSTN call via the injected `SipTrunkClient`
// boundary (`@ethosagent/platform-voice`) and bridges it into a LiveKit room,
// where the existing VoiceChannelAdapter -> VoiceSession stack handles the
// conversation. The concrete SIP binding (`livekit-server-sdk` SIP API) is
// supplied at the app layer — this package binds ONLY to the interface, so it
// typechecks and unit-tests against a fake trunk.
//
// APPROVAL: the tool is marked `requiresApproval: true`, so AgentLoop emits a
// `tool_approval_required` event and gates execution on the approval surface
// before the call is ever placed — the same mechanism every human-in-the-loop
// tool uses (packages/core/.../tool-processing.ts). An autonomous turn cannot
// dial a phone number without an explicit approval.

import type {
  OutboundCallHandle,
  OutboundCallRequest,
  SipTrunkClient,
} from '@ethosagent/platform-voice';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

export interface VoiceToolsOptions {
  /** SIP trunk boundary used to place the call. */
  trunk: SipTrunkClient;
  /**
   * LiveKit room the outbound call is bridged into, derived from the
   * destination number. Defaults to `call-<sanitized toNumber>`. The agent
   * joins the same room via the app-layer LiveKit transport.
   */
  roomNameFor?: (toNumber: string) => string;
  /** Caller-ID presented to the callee (E.164). From `voice.trunk.fromNumber`. */
  fromNumber?: string;
}

export function createVoiceTools(opts: VoiceToolsOptions): Tool[] {
  return [makeCallTool(opts)];
}

interface CallArgs {
  to_number: string;
  room_name?: string;
}

function makeCallTool(opts: VoiceToolsOptions): Tool {
  return {
    name: 'call',
    description:
      'Place an outbound phone call to an E.164 number and connect it to the live voice agent. ' +
      'This dials a real phone number and always requires explicit approval before the call is placed.',
    toolset: 'voice',
    maxResultChars: 512,
    capabilities: {},
    requiresApproval: true,
    schema: {
      type: 'object',
      properties: {
        to_number: {
          type: 'string',
          description: 'Destination phone number in E.164 format (e.g. +15551234567).',
        },
        room_name: {
          type: 'string',
          description:
            'Optional LiveKit room to bridge the call into. Defaults to a per-call room.',
        },
      },
      required: ['to_number'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      return await executeCall(args as CallArgs, ctx, opts);
    },
  };
}

async function executeCall(
  args: CallArgs,
  _ctx: ToolContext,
  opts: VoiceToolsOptions,
): Promise<ToolResult> {
  const toNumber = args.to_number?.trim();
  if (!toNumber || !/^\+[1-9]\d{6,14}$/.test(toNumber)) {
    return {
      ok: false,
      code: 'input_invalid',
      error: `to_number must be an E.164 number (e.g. +15551234567), got: ${args.to_number ?? '(missing)'}`,
      field: 'to_number',
    };
  }
  const roomName = args.room_name?.trim() || defaultRoomName(toNumber, opts.roomNameFor);
  const req: OutboundCallRequest = {
    toNumber,
    roomName,
    ...(opts.fromNumber ? { fromNumber: opts.fromNumber } : {}),
  };
  try {
    const handle: OutboundCallHandle = await opts.trunk.createOutboundCall(req);
    return {
      ok: true,
      value: `Calling ${handle.toNumber} (call ${handle.callId}, room ${handle.roomName}).`,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'execution_failed',
      error: `Failed to place call to ${toNumber}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    };
  }
}

function defaultRoomName(toNumber: string, roomNameFor?: (n: string) => string): string {
  if (roomNameFor) return roomNameFor(toNumber);
  return `call-${toNumber.replace(/[^0-9]/g, '')}`;
}
