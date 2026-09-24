// Contract ⇄ Jev wire mapping (plan §5.2).
//
// The Jev wire name `noul` appears only in this package: the contract's
// question names are provider-neutral (§4). An answer that does not match what
// was asked — wrong type, missing id, a probability outside 0..1, a non-finite
// number, a choice that was not offered — is `malformed`, never a default
// (D10). Pinned by `__tests__/mapping.test.ts`.

import type { DecisionAnswer, DecisionQuestion, DecisionResult } from './contract';

type WireQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export function toWireQuestion(question: DecisionQuestion): WireQuestion {
  switch (question.type) {
    case 'boolean':
      return question.criteria === undefined
        ? { type: 'noul', instructions: question.instructions }
        : { type: 'noul', instructions: question.instructions, criteria: question.criteria };
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.criteria };
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.criteria };
  }
}

export function toWireQuestions(
  questions: Record<string, DecisionQuestion>,
): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (const [id, q] of Object.entries(questions)) out[id] = toWireQuestion(q);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Index of the largest probability; the first wins a tie. */
export function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? 0) > (values[best] ?? 0)) best = i;
  }
  return best;
}

class Malformed extends Error {}

function mapAnswer(id: string, question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) throw new Malformed(`answer "${id}" is missing`);
  switch (question.type) {
    case 'boolean': {
      if (raw.type !== 'noul') throw new Malformed(`answer "${id}" is not a noul`);
      const p = raw.noul;
      if (!isProbability(p)) throw new Malformed(`answer "${id}": noul is not a probability`);
      // Jev's noul carries no confidence; the contract's uniform one is |2p − 1| (§4).
      return { type: 'boolean', p, confidence: Math.abs(2 * p - 1) };
    }
    case 'choice': {
      if (raw.type !== 'choice') throw new Malformed(`answer "${id}" is not a choice`);
      const { choice, probabilities, confidence } = raw;
      if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) {
        throw new Malformed(`answer "${id}": choice is not one of the offered options`);
      }
      if (!isRecord(probabilities) || !Object.values(probabilities).every(isProbability)) {
        throw new Malformed(`answer "${id}": probabilities are not all in 0..1`);
      }
      if (!isProbability(confidence)) throw new Malformed(`answer "${id}": bad confidence`);
      return {
        type: 'choice',
        choice,
        probabilities: probabilities as Record<string, number>,
        confidence,
      };
    }
    case 'score': {
      if (raw.type !== 'score') throw new Malformed(`answer "${id}" is not a score`);
      const { score, probabilities, confidence } = raw;
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Malformed(`answer "${id}": score is not a finite number`);
      }
      if (
        !Array.isArray(probabilities) ||
        probabilities.length !== question.criteria.length ||
        !probabilities.every(isProbability)
      ) {
        throw new Malformed(`answer "${id}": probabilities do not match the asked levels`);
      }
      if (!isProbability(confidence)) throw new Malformed(`answer "${id}": bad confidence`);
      // `legend` is dropped: the caller wrote the levels and holds them (§4).
      const probs = probabilities as number[];
      return { type: 'score', level: argmax(probs), score, probabilities: probs, confidence };
    }
  }
}

export function mapResponse(
  questions: Record<string, DecisionQuestion>,
  body: unknown,
): DecisionResult {
  try {
    if (!isRecord(body)) throw new Malformed('response is not an object');
    const { model, answers, usage } = body;
    if (typeof model !== 'string' || model === '') throw new Malformed('response has no model');
    if (!isRecord(answers)) throw new Malformed('response has no answers');
    if (!isRecord(usage) || !isCount(usage.input_tokens) || !isCount(usage.output_tokens)) {
      throw new Malformed('response has no usage');
    }
    const mapped: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      mapped[id] = mapAnswer(id, question, answers[id]);
    }
    return {
      ok: true,
      answers: mapped,
      model,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    };
  } catch (err) {
    if (err instanceof Malformed) {
      return { ok: false, code: 'malformed', message: `typesafe: ${err.message}` };
    }
    throw err;
  }
}
