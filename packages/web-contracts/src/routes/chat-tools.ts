import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  ApprovalLeaseSchema,
  ApprovalScopeSchema,
  OnboardingStepSchema,
  ProviderIdSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Chat
//
// `chat.send` is fire-and-(quickly)-forget — it returns once the turn has
// been kicked off on the server. The agent's actual response streams over
// SSE on `/sse/sessions/:sessionId`. `clientId` distinguishes multiple
// browser tabs writing to the same session (CEO finding 4.1).
// ---------------------------------------------------------------------------

const ChatSendInput = z.object({
  /** Existing session ID, or omit to start a new session. */
  sessionId: z.string().optional(),
  clientId: z.string().min(1),
  text: z.string().min(1),
  personalityId: z.string().optional(),
  userId: z.string().optional(),
  /** When true, the agent plans tool calls without executing them. The SSE
   *  stream emits a `dry_run_summary` event with the tool plan instead of
   *  running the tools. */
  dryRun: z.boolean().optional(),
  /**
   * Start this conversation incognito (plan incognito-sessions D5). Honoured only
   * when `sessionId` is absent: an existing session keeps its own stamp, so this
   * can never downgrade an incognito session. Enforced in `ChatService.send`.
   */
  incognito: z.boolean().optional(),
  /**
   * How this turn's text reached the client. `voice` means `text` is a
   * transcript of the user speaking (talk-mode), which the server turns into a
   * MESSAGE-LEVEL voice-origin annotation on the turn — never a system-prompt
   * section, because one session mixes typed and spoken turns. Default `text`.
   */
  origin: z.enum(['text', 'voice']).optional(),
  attachments: z
    .array(
      z.object({
        type: z.enum(['image', 'file']),
        data: z.string(),
        mimeType: z.string(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});
const ChatSendOutput = z.object({
  sessionId: z.string(),
  /** Echoed back so a tab knows which turn the SSE stream belongs to. */
  turnId: z.string(),
});

const ChatAbortInput = z.object({ sessionId: z.string() });
const ChatAbortOutput = z.object({ ok: z.literal(true) });

const ChatSteerInput = z.object({ sessionId: z.string(), text: z.string().min(1) });
const ChatSteerOutput = z.object({ ok: z.boolean() });

const ChatEndIncognitoInput = z.object({ sessionId: z.string() });
const ChatEndIncognitoOutput = z.object({
  ok: z.literal(true),
  /** Messages whose content was blanked, descendants included. */
  scrubbed: z.number().int().nonnegative(),
});

/** @stable v1 */
export const chat = {
  send: oc.input(ChatSendInput).output(ChatSendOutput),
  abort: oc.input(ChatAbortInput).output(ChatAbortOutput),
  steer: oc.input(ChatSteerInput).output(ChatSteerOutput),
  /**
   * End an incognito session: blank its transcript (and its descendants') and
   * drop its cards and attachments. Refused with `INVALID_INPUT` for a session
   * that is not incognito. Cookie-only: not in the API-key scope map.
   */
  endIncognito: oc.input(ChatEndIncognitoInput).output(ChatEndIncognitoOutput),
};

// ---------------------------------------------------------------------------
// Tools — approval workflow for dangerous tool calls
// ---------------------------------------------------------------------------

const ToolApproveInput = z.object({
  approvalId: z.string(),
  /** Tab identity. Other tabs viewing this session see `decidedBy: clientId`
   *  on the `approval.resolved` SSE event so the modal auto-dismisses with
   *  "approved by another window." */
  clientId: z.string().min(1),
  scope: ApprovalScopeSchema,
});
const ToolApproveOutput = z.object({ ok: z.literal(true) });

const ToolDenyInput = z.object({
  approvalId: z.string(),
  clientId: z.string().min(1),
  reason: z.string().optional(),
});
const ToolDenyOutput = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Approvals — time-limited grants (reach-and-containment 3b). Listed and
// revoked from Settings → Approvals; granted through `tools.approve` with
// scope `lease-1h`. Not in the API-key SCOPE_MAP, so cookie-only.
// ---------------------------------------------------------------------------

const ApprovalLeasesListOutput = z.object({ leases: z.array(ApprovalLeaseSchema) });
const ApprovalLeasesRevokeInput = z.object({ id: z.string().min(1) });
const ApprovalLeasesRevokeOutput = z.object({ ok: z.literal(true) });

/** @stable v1 */
export const approvals = {
  leases: {
    list: oc.output(ApprovalLeasesListOutput),
    revoke: oc.input(ApprovalLeasesRevokeInput).output(ApprovalLeasesRevokeOutput),
  },
};

const ToolsCatalogInput = z.object({});
const ToolsCatalogOutput = z.object({
  groups: z.array(
    z.object({
      group: z.string(),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
    }),
  ),
});

/** Mirrors `ToolCapabilities` in `@ethosagent/types` — the declared reach a
 *  tool asks for. Surfaced verbatim so the Personality Edit modal can show what
 *  a tool is allowed to touch before it is added to a toolset. */
const ToolCapabilitiesSchema = z.object({
  network: z.object({ allowedHosts: z.array(z.string()) }).optional(),
  secrets: z.array(z.string()).optional(),
  storage: z
    .object({
      scope: z.enum(['tool-private', 'session', 'personality']),
      kind: z.literal('kv'),
      ttlSecondsDefault: z.number().optional(),
    })
    .optional(),
  fs_reach: z
    .object({
      read: z.union([z.array(z.string()), z.literal('from-personality')]).optional(),
      write: z.union([z.array(z.string()), z.literal('from-personality')]).optional(),
    })
    .optional(),
  process: z.object({ allowedBinaries: z.array(z.string()) }).optional(),
  attachments: z
    .object({ kinds: z.union([z.array(z.enum(['image', 'file'])), z.literal('*')]) })
    .optional(),
});

/** Whether this tool may be ACTUALLY EXECUTED by `tools.test`. Computed
 *  server-side from the tool's declared capabilities; the client never gets to
 *  assert it. `reason` is populated only when `canRun` is false. */
const ToolTestEligibilitySchema = z.object({
  canRun: z.boolean(),
  reason: z.string().optional(),
});

const ToolsDetailInput = z.object({
  name: z.string().min(1),
  /** When supplied, `inPersonalityToolset` reports whether this personality's
   *  toolset reaches the tool. Omitted → the field is absent. */
  personalityId: z.string().optional(),
});
/** Full detail for ONE tool. An unregistered name is not an error: it comes
 *  back well-formed with `registered: false`, which is how the modal tells a
 *  user that their toolset names a tool this deployment does not have. */
const ToolsDetailOutput = z.object({
  name: z.string(),
  description: z.string(),
  toolset: z.string().optional(),
  /** Capitalised `toolset`, or `'Other'` — the same grouping `catalog` uses. */
  group: z.string(),
  /** The tool's JSON schema, passed through untouched. */
  schema: z.record(z.string(), z.unknown()),
  capabilities: ToolCapabilitiesSchema,
  maxResultChars: z.number().optional(),
  requiresApproval: z.boolean().optional(),
  outputIsUntrusted: z.boolean().optional(),
  alwaysInclude: z.boolean().optional(),
  returnDirect: z.boolean().optional(),
  /** The schema itself is NOT dumped here — the tool-settings UI owns it. */
  hasSettingsSchema: z.boolean(),
  pluginId: z.string().optional(),
  /** False when no tool of this name is registered in this deployment. */
  registered: z.boolean(),
  /** False when the tool is registered but its `isAvailable()` says no
   *  (missing API key, absent binary). Always false when `registered` is. */
  available: z.boolean(),
  /** Present only when the request carried a `personalityId`. */
  inPersonalityToolset: z.boolean().optional(),
  testEligibility: ToolTestEligibilitySchema,
});

const ToolsTestInput = z.object({
  name: z.string().min(1),
  personalityId: z.string().min(1),
  /** `'run'` is a REQUEST, not a grant: the server re-derives eligibility and
   *  silently degrades to verify-only for anything it will not execute. */
  mode: z.enum(['verify', 'run']),
});
const ToolsTestOutput = z.object({
  /** Always populated, in both modes, in this order: `registered`,
   *  `available`, `in-toolset`, `args-valid`. A check downstream of a failure
   *  reports `skip`. */
  checks: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: z.enum(['pass', 'fail', 'skip']),
      detail: z.string().optional(),
    }),
  ),
  /** True only when the tool was actually executed. */
  ran: z.boolean(),
  /** Present only when `ran` is true. */
  result: z
    .object({
      ok: z.boolean(),
      value: z.string().optional(),
      error: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
  /** Wall clock of the execution. Present only when `ran` is true. */
  durationMs: z.number().optional(),
  /** Why a `mode: 'run'` request did or did not execute. */
  testEligibility: ToolTestEligibilitySchema,
});

/** @experimental */
export const tools = {
  approve: oc.input(ToolApproveInput).output(ToolApproveOutput),
  deny: oc.input(ToolDenyInput).output(ToolDenyOutput),
  catalog: oc.input(ToolsCatalogInput).output(ToolsCatalogOutput),
  detail: oc.input(ToolsDetailInput).output(ToolsDetailOutput),
  test: oc.input(ToolsTestInput).output(ToolsTestOutput),
};

// ---------------------------------------------------------------------------
// Clarify — resolve a pending `clarify` request (the agent asked the user a
// question mid-turn). The request side flows out over SSE; this is the answer
// path back, mirroring the tool-approval transport.
//
// `listPending` is the catch-up read for the request side, the same role
// `tasks.list` plays for the run digest: the `clarify.request` push is live
// only, so a page that mounts after a delegated run parked on a question has
// no way to learn the question exists. `ClarifyBridge.listPersisted` was
// built for exactly this and had no route to the browser until now.
// ---------------------------------------------------------------------------

const ClarifyRespondInput = z.object({
  requestId: z.string(),
  /** The user's answer — free-form text, or one of the offered options. */
  answer: z.string(),
  /** `user` for a real answer, `cancel` when the user dismissed the card. */
  source: z.enum(['user', 'cancel']),
});
const ClarifyRespondOutput = z.object({ ok: z.literal(true) });

/** Scoped by root session, never by clarify `sessionId`: a delegated run asks
 *  on its CHILD session key (`clarify-escalator.ts`), which no browser is ever
 *  subscribed to. The lane a surface can actually join on is the job (G1). */
const ClarifyListPendingInput = z.object({ rootSessionKey: z.string().min(1) });
/** One open question, shaped so the client can fold it straight into the same
 *  queue the `clarify.request` event feeds. `jobId` is required — every row
 *  here belongs to one of this session's runs by construction. */
const ClarifyListPendingOutput = z.array(
  z.object({
    requestId: z.string(),
    jobId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    default: z.string().optional(),
    /** Never null here: only PRESENTED rows are returned, and presentation is
     *  what starts the clock (D2). A row still queued behind another question
     *  in its lane has been shown to nobody and is not offered for answering. */
    defaultDeadlineAt: z.string(),
  }),
);

/** @experimental */
export const clarify = {
  respond: oc.input(ClarifyRespondInput).output(ClarifyRespondOutput),
  listPending: oc.input(ClarifyListPendingInput).output(ClarifyListPendingOutput),
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const OnboardingStateOutput = z.object({
  step: OnboardingStepSchema,
  /** True once `~/.ethos/config.yaml` has a valid provider + key. */
  hasProvider: z.boolean(),
  /** Set after step 3. */
  selectedPersonalityId: z.string().nullable(),
});

const OnboardingValidateProviderInput = z.object({
  provider: ProviderIdSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});
const OnboardingValidateProviderOutput = z.object({
  ok: z.boolean(),
  /** Models returned by the provider's catalog endpoint when validation succeeds. */
  models: z.array(z.string()).nullable(),
  error: z.string().nullable(),
  completionTested: z.boolean(),
});

const OnboardingCompleteInput = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  personalityId: z.string().min(1),
});
const OnboardingCompleteOutput = z.object({ ok: z.literal(true) });

/** @experimental */
export const onboarding = {
  state: oc.output(OnboardingStateOutput),
  validateProvider: oc
    .input(OnboardingValidateProviderInput)
    .output(OnboardingValidateProviderOutput),
  complete: oc.input(OnboardingCompleteInput).output(OnboardingCompleteOutput),
};
