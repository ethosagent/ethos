// `propose_self_amendment` — a personality files a request to change its own
// `toolset.yaml` (plan personality-memory-boundary-and-self-amendment, G2).
//
// The tool only FILES. It holds an `AmendmentSubmitPort` and nothing else, so
// it has no path to apply, decline or roll back anything (G2-1 (b)); applying
// is a human action at the TTY-gated CLI. Every check that decides whether a
// filing is allowed — who started the turn, taint, opt-in, built-ins, the ops,
// the evidence, the limits and the constitution — lives in the port's
// implementation, `createAmendmentIntake` in packages/wiring/src/amendments.ts,
// pinned by packages/wiring/src/__tests__/propose-amendment.test.ts. This file
// only shapes and bounds the arguments.
//
// There is no target argument: the intake files for `ctx.personalityId` and
// nothing else (G2-2). It never reads `process.env`.

import type {
  AmendmentOp,
  AmendmentSubmitPort,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';

/** The tool's name. A personality opts in by listing it in its own `toolset.yaml`. */
export const PROPOSE_SELF_AMENDMENT_TOOL = 'propose_self_amendment';

/** Bounds the schema states and `execute` re-checks. */
export const PROPOSE_AMENDMENT_LIMITS = {
  maxOps: 10,
  maxRationale: 1000,
  maxEvidence: 10,
} as const;

interface ProposeArgs {
  ops: AmendmentOp[];
  rationale: string;
  evidenceToolCallIds?: string[];
}

function invalid(error: string, field: string): ToolResult {
  return { ok: false, code: 'input_invalid', error, field };
}

/** Validate the raw arguments. Returns the typed args, or the refusal. */
function parseArgs(raw: unknown): ProposeArgs | ToolResult {
  if (!raw || typeof raw !== 'object') return invalid('Arguments must be an object.', 'ops');
  const args = raw as Record<string, unknown>;

  const rawOps = args.ops;
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return invalid('`ops` must be a non-empty array.', 'ops');
  }
  if (rawOps.length > PROPOSE_AMENDMENT_LIMITS.maxOps) {
    return invalid(`\`ops\` holds at most ${PROPOSE_AMENDMENT_LIMITS.maxOps} entries.`, 'ops');
  }
  const ops: AmendmentOp[] = [];
  for (const entry of rawOps) {
    if (!entry || typeof entry !== 'object') return invalid('Each op must be an object.', 'ops');
    const { op, tool } = entry as Record<string, unknown>;
    if (op !== 'add_tool' && op !== 'remove_tool') {
      return invalid('Each op must be `add_tool` or `remove_tool`.', 'ops');
    }
    if (typeof tool !== 'string' || tool.trim() === '') {
      return invalid('Each op must name a `tool`.', 'ops');
    }
    ops.push({ op, tool: tool.trim() });
  }

  const rationale = args.rationale;
  if (typeof rationale !== 'string' || rationale.trim() === '') {
    return invalid('`rationale` must be a non-empty string.', 'rationale');
  }
  if (rationale.length > PROPOSE_AMENDMENT_LIMITS.maxRationale) {
    return invalid(
      `\`rationale\` is at most ${PROPOSE_AMENDMENT_LIMITS.maxRationale} characters.`,
      'rationale',
    );
  }

  const rawEvidence = args.evidence_tool_call_ids;
  if (rawEvidence === undefined) return { ops, rationale };
  if (
    !Array.isArray(rawEvidence) ||
    rawEvidence.some((id) => typeof id !== 'string' || id === '')
  ) {
    return invalid('`evidence_tool_call_ids` must be an array of tool-call ids.', 'evidence');
  }
  if (rawEvidence.length > PROPOSE_AMENDMENT_LIMITS.maxEvidence) {
    return invalid(
      `\`evidence_tool_call_ids\` holds at most ${PROPOSE_AMENDMENT_LIMITS.maxEvidence} ids.`,
      'evidence',
    );
  }
  return { ops, rationale, evidenceToolCallIds: rawEvidence as string[] };
}

function isToolResult(value: ProposeArgs | ToolResult): value is ToolResult {
  return 'ok' in value;
}

/**
 * Build the tool. `port` is the only capability it receives; with none wired
 * the tool reports itself unavailable.
 */
export function createProposeSelfAmendmentTool(port: AmendmentSubmitPort | undefined): Tool {
  return {
    name: PROPOSE_SELF_AMENDMENT_TOOL,
    description:
      'File a request to add tools to, or remove tools from, YOUR OWN toolset. It only files a ' +
      'request: nothing changes until your owner reviews and applies it. Use it when a tool you ' +
      'need was refused as not permitted for this personality, or a tool you hold is one you ' +
      'should not have. Cite the refused tool call ids as evidence when you have them. Only ' +
      'works in a private conversation your owner started from the CLI or the web app.',
    toolset: 'self_amendment',
    capabilities: {},
    maxResultChars: 2000,
    isAvailable: () => port !== undefined,
    schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          maxItems: PROPOSE_AMENDMENT_LIMITS.maxOps,
          description: 'The toolset changes to request.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add_tool', 'remove_tool'] },
              tool: { type: 'string', description: 'A registered tool name.' },
            },
            required: ['op', 'tool'],
          },
        },
        rationale: {
          type: 'string',
          maxLength: PROPOSE_AMENDMENT_LIMITS.maxRationale,
          description: 'Why, in plain words, for the owner who reviews it.',
        },
        evidence_tool_call_ids: {
          type: 'array',
          maxItems: PROPOSE_AMENDMENT_LIMITS.maxEvidence,
          items: { type: 'string' },
          description: 'Ids of refused tool calls in THIS conversation that show the need.',
        },
      },
      required: ['ops', 'rationale'],
    },
    async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!port) {
        return { ok: false, code: 'not_available', error: 'Self-amendment is not wired here.' };
      }
      const parsed = parseArgs(raw);
      if (isToolResult(parsed)) return parsed;

      const result = await port.submit(
        {
          ops: parsed.ops,
          rationale: parsed.rationale,
          ...(parsed.evidenceToolCallIds
            ? { evidenceToolCallIds: parsed.evidenceToolCallIds }
            : {}),
        },
        ctx,
      );
      if (!result.ok) {
        return { ok: false, code: 'not_available', error: `Not filed: ${result.reason}` };
      }
      if (result.status === 'auto_rejected') {
        return {
          ok: true,
          value:
            `Amendment ${result.id} was rejected automatically: the operator's constitution ` +
            `forbids the result (${result.reason ?? 'no reason given'}). Nothing changed.`,
        };
      }
      if (result.deduped) {
        return {
          ok: true,
          value: `An identical request is already pending as ${result.id}. Nothing new was filed.`,
        };
      }
      return {
        ok: true,
        value:
          `Filed amendment ${result.id}. It is pending your owner's review; nothing changes ` +
          'until they apply it.',
      };
    },
  };
}
