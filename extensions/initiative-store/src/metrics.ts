import type { SQLiteInitiativeStore } from './store';

export interface GateMetrics {
  gate1: { asked: number; approved: number; rate: number };
  gate2: { briefs: number; adopted: number; rate: number };
  selfStart: { started: number; kept: number; stopped: number };
}

const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);

/**
 * Gate outcomes since `sinceIso`, counted from the decisions ledger (so they are
 * right from the first decision, with no separate counter to drift).
 * gate1 `asked` is answered requests (approve + reject; a snooze is not an
 * answer). gate2 `briefs` is briefs that reached the owner (adopt, park or dig
 * deeper) and `adopted` the adopts among them. selfStart `started` is the
 * self-started initiatives the owner ruled on; `kept` includes make_mine.
 */
export function computeGateMetrics(
  store: SQLiteInitiativeStore,
  personalityId: string,
  sinceIso: string,
): GateMetrics {
  const count = (gate: string, verdicts: string[]) =>
    store
      .decisionsSince(personalityId, sinceIso)
      .filter((d) => d.gate === gate && verdicts.includes(d.verdict)).length;
  const asked = count('gate1_explore', ['approve', 'reject']);
  const approved = count('gate1_explore', ['approve']);
  const briefs = count('gate2_adopt', ['adopt', 'park', 'dig_deeper']);
  const adopted = count('gate2_adopt', ['adopt']);
  const kept = count('self_start', ['keep', 'make_mine']);
  const stopped = count('self_start', ['stop']);
  return {
    gate1: { asked, approved, rate: rate(approved, asked) },
    gate2: { briefs, adopted, rate: rate(adopted, briefs) },
    selfStart: { started: kept + stopped, kept, stopped },
  };
}
