// @ethosagent/tools-decision — the `decide` tool (plan/phases/decision-tool.md).
//
// The agent sends a state and typed questions to the build's decision model
// (Jev) and gets typed answers with probabilities back — never prose. The tool
// holds only what the model sees: the input schema and caps (D3), the
// description (D11), the result formatting (D9) and the error mapping (D10).
// It never builds a provider (D4): wiring injects a `DecideFn`
// (`createDecisionToolDecide`, packages/wiring/src/decision-tool.ts) that runs
// on the build's one provider handle, validates, redacts and records. Pinned by
// `__tests__/decide-tool.test.ts`.

import type {
  DecisionAnswer,
  DecisionErrorCode,
  DecisionQuestion,
  DecisionRequest,
  Tool,
  ToolResult,
} from '@ethosagent/types';

/** D3 — at most this many questions per call. */
export const DECIDE_MAX_QUESTIONS = 8;
/** D3 — at most this many chars of state (JSON text for an object or array). */
export const DECIDE_MAX_STATE_CHARS = 24_000;

export interface DecideCall {
  state: DecisionRequest['state'];
  questions: Record<string, DecisionQuestion>;
  signal: AbortSignal;
  personalityId?: string;
  sessionId?: string;
}

/**
 * What the injected decide function answers. `no_key` is the one failure no
 * `DecisionErrorCode` names: the operator configured a provider but the vault
 * holds no key, so no provider exists (D5).
 */
export type DecideOutcome =
  | {
      ok: true;
      answers: Record<string, DecisionAnswer>;
      /** The model id the provider RETURNED. */
      model: string;
      latencyMs: number;
      calibrated: boolean;
      costUsd: number;
    }
  | { ok: false; code: DecisionErrorCode | 'no_key'; message: string };

export type DecideFn = (call: DecideCall) => Promise<DecideOutcome>;

export interface CreateDecideToolOptions {
  decide: DecideFn;
}

interface DecideArgs {
  state?: unknown;
  questions?: unknown;
}

const DESCRIPTION = [
  'Ask the decision model (Jev) a typed judgement question and get calibrated probabilities back.',
  '',
  'Call `decide` when the user says "decide", "let\'s decide", "ask Jev", or asks you to grade, ' +
    'rank or pick with the decision model — or when the task is a yes/no, pick-one-of-N, or ' +
    'score-on-a-rubric judgement over state you already have in hand. Gather the facts first; ' +
    'Jev judges only what you put in `state`.',
  '',
  'Shape each question as one of three types, each with one `instructions` sentence:',
  '- boolean: `criteria` = { "true": "<what yes means>", "false": "<what no means>" }.',
  '- choice: `criteria` = { "<option>": "<what this option means>", ... }, one entry per option.',
  '- score: `criteria` = ["<level 1 description>", "<level 2>", ...], ordered lowest to highest, ' +
    '2-10 levels.',
  `Up to ${DECIDE_MAX_QUESTIONS} questions per call; \`state\` up to ${DECIDE_MAX_STATE_CHARS} ` +
    'characters (a string, or an object/array of the relevant facts).',
  '',
  'Example:',
  '{"state":{"symbol":"RELIANCE","price":2940,"above50dma":true,"rsi":61,"volumeVs20d":1.4},' +
    '"questions":{"buy":{"type":"boolean","instructions":"Is this a buy on the current setup?",' +
    '"criteria":{"true":"risk/reward favours entering now","false":"wait or avoid"}},' +
    '"setup":{"type":"choice","instructions":"Which setup is this?","criteria":' +
    '{"breakout":"price cleared resistance on volume","range":"price inside a range",' +
    '"reversal":"trend is turning"}}}}',
  '',
  'It returns one line per question — `id: yes p=0.82 conf=0.71`, `id: <choice> (<option> <p>, ...) ' +
    'conf=…`, or `id: level 3/5 score=… conf=…` — plus a `model=… latency=… calibrated=…` line. ' +
    'These are probabilities, not prose: report them as Jev\'s answer (e.g. "Jev: yes, p=0.82, ' +
    'confidence 0.71"). If the call fails, tell the user Jev did not answer; never substitute your ' +
    "own judgement as Jev's.",
].join('\n');

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['boolean', 'choice', 'score'] },
    instructions: { type: 'string', description: 'One sentence: what to judge.' },
    criteria: {
      type: ['object', 'array'],
      description:
        'boolean: {"true": "...", "false": "..."}; choice: {"<option>": "<description>", ...}; ' +
        'score: ["<level 1>", "<level 2>", ...] ordered lowest to highest.',
    },
  },
  required: ['type', 'instructions'],
};

const FAILURE_TAIL =
  "Tell the user Jev did not answer; do not substitute your own judgement as Jev's.";

/** D10 — provider codes → the closed `ToolResult` error codes. */
function failure(code: DecisionErrorCode | 'no_key', message: string): ToolResult {
  const error = `Jev failed (${code}): ${message} ${FAILURE_TAIL}`;
  switch (code) {
    case 'invalid':
    case 'too_large':
      return { ok: false, code: 'input_invalid', error };
    case 'auth':
    case 'unavailable':
    case 'breaker_open':
    case 'no_key':
      return { ok: false, code: 'not_available', error };
    default:
      return { ok: false, code: 'execution_failed', error };
  }
}

function inputInvalid(message: string, field: string): ToolResult {
  return { ok: false, code: 'input_invalid', error: `decide: ${message}`, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fmt = (n: number): string => n.toFixed(2);

/** D9 — one compact line per answer. */
function answerLine(id: string, answer: DecisionAnswer, question: DecisionQuestion | undefined) {
  switch (answer.type) {
    case 'boolean':
      return `${id}: ${answer.p >= 0.5 ? 'yes' : 'no'} p=${fmt(answer.p)} conf=${fmt(answer.confidence)}`;
    case 'choice': {
      const ranked = Object.entries(answer.probabilities)
        .sort(([, a], [, b]) => b - a)
        .map(([option, p]) => `${option} ${fmt(p)}`)
        .join(', ');
      return `${id}: ${answer.choice} (${ranked}) conf=${fmt(answer.confidence)}`;
    }
    case 'score': {
      const levels =
        question?.type === 'score' ? question.criteria.length : answer.probabilities.length;
      return (
        `${id}: level ${answer.level + 1}/${levels} score=${fmt(answer.score)} ` +
        `conf=${fmt(answer.confidence)}`
      );
    }
  }
}

export function createDecideTool(opts: CreateDecideToolOptions): Tool {
  return {
    name: 'decide',
    description: DESCRIPTION,
    toolset: 'decision',
    maxResultChars: 4000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        state: {
          type: ['string', 'object', 'array'],
          description: 'The facts to judge: a string, or an object/array of the relevant data.',
        },
        questions: {
          type: 'object',
          description: 'Map of question id → question. Ids are short snake_case names.',
          additionalProperties: QUESTION_SCHEMA,
        },
      },
      required: ['state', 'questions'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { state, questions } = (args ?? {}) as DecideArgs;
      if (typeof state !== 'string' && !isRecord(state) && !Array.isArray(state)) {
        return inputInvalid('state must be a string, an object or an array', 'state');
      }
      if (!isRecord(questions) || Object.keys(questions).length === 0) {
        return inputInvalid('questions must be a non-empty map of id → question', 'questions');
      }
      const count = Object.keys(questions).length;
      if (count > DECIDE_MAX_QUESTIONS) {
        return inputInvalid(
          `at most ${DECIDE_MAX_QUESTIONS} questions per call, got ${count}; split the decision`,
          'questions',
        );
      }
      const stateChars = typeof state === 'string' ? state.length : JSON.stringify(state).length;
      if (stateChars > DECIDE_MAX_STATE_CHARS) {
        return inputInvalid(
          `state is ${stateChars} characters, over the ${DECIDE_MAX_STATE_CHARS} limit; ` +
            'keep only the facts the questions need',
          'state',
        );
      }

      const typed = questions as Record<string, DecisionQuestion>;
      const outcome = await opts.decide({
        state,
        questions: typed,
        signal: ctx.abortSignal,
        ...(ctx.personalityId !== undefined ? { personalityId: ctx.personalityId } : {}),
        sessionId: ctx.sessionId,
      });
      if (!outcome.ok) return failure(outcome.code, outcome.message);

      const lines = Object.entries(outcome.answers).map(([id, answer]) =>
        answerLine(id, answer, typed[id]),
      );
      lines.push(
        `model=${outcome.model} latency=${outcome.latencyMs}ms calibrated=${outcome.calibrated}`,
      );
      return {
        ok: true,
        value: lines.join('\n'),
        structured: {
          answers: outcome.answers,
          model: outcome.model,
          latencyMs: outcome.latencyMs,
          calibrated: outcome.calibrated,
        },
        cost_usd: outcome.costUsd,
      };
    },
  };
}
