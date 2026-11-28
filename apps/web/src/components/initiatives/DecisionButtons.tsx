import type { InitiativeDecideInput } from '@ethosagent/web-contracts';

interface Choice {
  verdict: string;
  label: string;
  input: InitiativeDecideInput;
}

export function DecisionButtons({
  choices,
  busy,
  onDecide,
}: {
  choices: Choice[];
  busy: boolean;
  onDecide: (input: InitiativeDecideInput) => void;
}) {
  return (
    <div className="initiative-actions">
      {choices.map((c) => (
        <button
          key={c.verdict}
          type="button"
          className="page-action-btn"
          data-testid={`decide-${c.verdict}`}
          disabled={busy}
          onClick={() => onDecide(c.input)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function briefChoices(id: string, option: string | null | undefined): Choice[] {
  return [
    {
      verdict: 'adopt',
      label: 'Adopt',
      input: {
        gate: 'gate2_adopt',
        verdict: 'adopt',
        target: id,
        ...(option ? { option } : {}),
      },
    },
    {
      verdict: 'dig_deeper',
      label: 'Dig deeper',
      input: { gate: 'gate2_adopt', verdict: 'dig_deeper', target: id },
    },
    { verdict: 'park', label: 'Park', input: { gate: 'gate2_adopt', verdict: 'park', target: id } },
  ];
}

export function proposalChoices(id: string): Choice[] {
  return [
    {
      verdict: 'approve',
      label: 'Approve',
      input: { gate: 'gate1_explore', verdict: 'approve', target: id },
    },
    {
      verdict: 'reject',
      label: 'Reject',
      input: { gate: 'gate1_explore', verdict: 'reject', target: id },
    },
  ];
}

export function selfStartChoices(id: string): Choice[] {
  return [
    { verdict: 'keep', label: 'Keep', input: { gate: 'self_start', verdict: 'keep', target: id } },
    {
      verdict: 'make_mine',
      label: 'Make it mine',
      input: { gate: 'self_start', verdict: 'make_mine', target: id },
    },
    { verdict: 'stop', label: 'Stop', input: { gate: 'self_start', verdict: 'stop', target: id } },
  ];
}
