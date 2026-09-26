import { type ReactNode, useState } from 'react';
import { useGoalSettings } from '../../features/goals/api/queries';

interface GoalIntakeModalProps {
  open: boolean;
  onClose: () => void;
  userMessage: string;
  restatedGoal: string;
  onQuickStart: (goalText: string) => void;
  onConfiguredRun: (config: {
    goalText: string;
    checks: Array<{ description: string; command?: string }>;
    rubric: Array<{ description: string; weight: number }>;
    boundaries: string;
    costLimit: number;
    trials: number;
    maxToolCallsPerTurn: number;
    maxIdenticalToolCalls: number;
    maxRecoveryAttempts: number;
    allowDangerousToolCalls: boolean;
  }) => void;
}

interface Criterion {
  id: string;
  type: 'check' | 'rubric';
  description: string;
  weight: number;
  /** Shell command the judge runs on the host; only sent when the server allows it. */
  command: string;
}

export function GoalIntakeModal({
  open,
  onClose,
  userMessage,
  restatedGoal,
  onQuickStart,
  onConfiguredRun,
}: GoalIntakeModalProps): ReactNode {
  const [showForm, setShowForm] = useState(false);
  const [criteria, setCriteria] = useState<Criterion[]>([
    { id: crypto.randomUUID(), type: 'check', description: '', weight: 50, command: '' },
  ]);
  // `goals.allowCheckCommands` — off (or unknown) shows no command field at all.
  const allowCheckCommands = useGoalSettings(open).data?.allowCheckCommands === true;
  const [boundaries, setBoundaries] = useState('');
  const [costLimit, setCostLimit] = useState(5);
  const [trials, setTrials] = useState(3);
  const [maxToolCallsPerTurn, setMaxToolCallsPerTurn] = useState(1000);
  const [maxIdenticalToolCalls, setMaxIdenticalToolCalls] = useState(25);
  const [maxRecoveryAttempts, setMaxRecoveryAttempts] = useState(2);
  const [allowDangerousToolCalls, setAllowDangerousToolCalls] = useState(false);
  // Set by a Run click that found a row it would otherwise drop; cleared by the next edit.
  const [showRowErrors, setShowRowErrors] = useState(false);

  if (!open) return null;

  // A check with a verify command but no description is a check the user
  // wrote. The submit filter below keeps only rows with a description, so such
  // a row — command included — would be dropped without a word; Run refuses
  // instead and marks the row.
  const lacksDescription = (c: Criterion) =>
    c.type === 'check' && !c.description.trim() && allowCheckCommands && c.command.trim() !== '';

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const addCriterion = () => {
    setCriteria((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: 'check', description: '', weight: 50, command: '' },
    ]);
  };

  const removeCriterion = (index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCriterion = (index: number, updates: Partial<Criterion>) => {
    setShowRowErrors(false);
    setCriteria((prev) => prev.map((c, i) => (i === index ? { ...c, ...updates } : c)));
  };

  const handleRunGoal = () => {
    if (criteria.some(lacksDescription)) {
      setShowRowErrors(true);
      return;
    }
    const checks = criteria
      .filter((c) => c.type === 'check' && c.description.trim())
      .map((c) => {
        const command = allowCheckCommands ? c.command.trim() : '';
        return command ? { description: c.description, command } : { description: c.description };
      });
    const rubric = criteria
      .filter((c) => c.type === 'rubric' && c.description.trim())
      .map((c) => ({ description: c.description, weight: c.weight }));
    onConfiguredRun({
      goalText: restatedGoal,
      checks,
      rubric,
      boundaries,
      costLimit,
      trials,
      maxToolCallsPerTurn,
      maxIdenticalToolCalls,
      maxRecoveryAttempts,
      allowDangerousToolCalls,
    });
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop dismiss
    <div
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          maxWidth: 560,
          width: '90vw',
          maxHeight: '85vh',
          overflowY: 'auto',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '12px',
          padding: 24,
          position: 'relative',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 500, color: 'var(--text-primary)' }}>
            Goal detected
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28,
              height: 28,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-tertiary)',
              fontSize: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              opacity: 0.8,
            }}
          >
            &times;
          </button>
        </div>

        {/* Chat strip */}
        <div
          style={{
            background: 'var(--bg-overlay)',
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: 14,
            color: 'var(--text-primary)',
            marginBottom: 8,
          }}
        >
          {userMessage}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 16,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--info)',
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Goal detected</span>
        </div>

        {/* Restated goal */}
        <div
          style={{
            fontSize: 14,
            color: 'var(--text-primary)',
            borderLeft: '3px solid var(--info)',
            paddingLeft: 12,
            marginBottom: 16,
          }}
        >
          {restatedGoal}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => onQuickStart(restatedGoal)}
            style={{
              background: 'var(--info)',
              color: 'white',
              fontSize: 14,
              fontWeight: 500,
              padding: '10px 20px',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Run now
          </button>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            style={{
              background: 'transparent',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-strong)',
              fontSize: 14,
              fontWeight: 500,
              padding: '10px 20px',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            Configure &amp; run
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
          Run now derives acceptance criteria automatically &middot; 3 trials &middot; cost capped
          by personality budget
        </div>

        {/* Expandable form */}
        {showForm && (
          <div>
            {/* Judging criteria */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  color: 'var(--text-secondary)',
                  letterSpacing: '0.08em',
                  marginBottom: 8,
                }}
              >
                Judging criteria
              </div>
              {criteria.map((c, i) => (
                <div key={c.id} style={{ marginBottom: 8 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <select
                      value={c.type}
                      onChange={(e) =>
                        updateCriterion(i, { type: e.target.value as 'check' | 'rubric' })
                      }
                      style={{
                        background: 'var(--bg-overlay)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                        borderRadius: '6px',
                        padding: 8,
                        fontSize: 13,
                      }}
                    >
                      <option value="check">check</option>
                      <option value="rubric">rubric</option>
                    </select>
                    <input
                      type="text"
                      value={c.description}
                      onChange={(e) => updateCriterion(i, { description: e.target.value })}
                      placeholder="Description"
                      aria-invalid={showRowErrors && lacksDescription(c)}
                      style={{
                        flex: 1,
                        background: 'var(--bg-overlay)',
                        border: `1px solid ${
                          showRowErrors && lacksDescription(c)
                            ? 'var(--error)'
                            : 'var(--border-subtle)'
                        }`,
                        color: 'var(--text-primary)',
                        borderRadius: '6px',
                        padding: 8,
                        fontSize: 13,
                      }}
                    />
                    {c.type === 'rubric' && (
                      <input
                        type="number"
                        value={c.weight}
                        onChange={(e) => updateCriterion(i, { weight: Number(e.target.value) })}
                        min={0}
                        max={100}
                        style={{
                          width: 60,
                          background: 'var(--bg-overlay)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-primary)',
                          borderRadius: '6px',
                          padding: 8,
                          fontSize: 13,
                        }}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeCriterion(i)}
                      aria-label="Remove criterion"
                      style={{
                        width: 24,
                        height: 24,
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-tertiary)',
                        cursor: 'pointer',
                        fontSize: 14,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                      }}
                    >
                      &times;
                    </button>
                  </div>
                  {showRowErrors && lacksDescription(c) && (
                    <div
                      role="alert"
                      style={{ fontSize: 11, color: 'var(--error)', marginTop: 4, lineHeight: 1.4 }}
                    >
                      Describe what this check verifies. A check needs a description to be sent.
                    </div>
                  )}
                  {allowCheckCommands && c.type === 'check' && (
                    <div
                      style={{
                        marginTop: 6,
                        marginLeft: 8,
                        paddingLeft: 12,
                        borderLeft: '1px solid var(--border-subtle)',
                      }}
                    >
                      <input
                        type="text"
                        value={c.command}
                        onChange={(e) => updateCriterion(i, { command: e.target.value })}
                        placeholder="python3 /path/to/check.py"
                        aria-label="Verify command"
                        spellCheck={false}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          background: 'var(--bg-overlay)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-primary)',
                          borderRadius: '6px',
                          padding: 8,
                          fontSize: 13,
                          fontFamily: "'Geist Mono', monospace",
                        }}
                      />
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--text-tertiary)',
                          marginTop: 4,
                          lineHeight: 1.4,
                        }}
                      >
                        Optional verify command. Runs on this machine when the goal is judged; the
                        check passes if it exits 0.
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addCriterion}
                style={{
                  background: 'transparent',
                  border: '1px dashed var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  padding: '8px 14px',
                  borderRadius: '6px',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                + Add criterion
              </button>
            </div>

            {/* Boundaries */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  color: 'var(--text-secondary)',
                  letterSpacing: '0.08em',
                  marginBottom: 8,
                }}
              >
                Boundaries
              </div>
              <textarea
                value={boundaries}
                onChange={(e) => setBoundaries(e.target.value)}
                placeholder="e.g. Don't modify production data"
                style={{
                  background: 'var(--bg-overlay)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  minHeight: 60,
                  resize: 'vertical',
                  width: '100%',
                  borderRadius: '6px',
                  padding: 10,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Cost & trials */}
            <div
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'flex-end',
                marginBottom: 16,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    letterSpacing: '0.08em',
                    marginBottom: 8,
                  }}
                >
                  Cost limit
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>$</span>
                  <input
                    type="number"
                    value={costLimit}
                    onChange={(e) => setCostLimit(Number(e.target.value))}
                    min={0}
                    style={{
                      width: 80,
                      background: 'var(--bg-overlay)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                      borderRadius: '6px',
                      padding: 8,
                      fontSize: 13,
                    }}
                  />
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    letterSpacing: '0.08em',
                    marginBottom: 8,
                  }}
                >
                  Trials
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                  <button
                    type="button"
                    onClick={() => setTrials((t) => Math.max(1, t - 1))}
                    aria-label="Decrease trials"
                    style={{
                      width: 28,
                      height: 28,
                      background: 'var(--bg-overlay)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                      fontSize: 16,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                  >
                    &minus;
                  </button>
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: "'Geist Mono', monospace",
                      fontSize: 13,
                      color: 'var(--text-primary)',
                    }}
                  >
                    {trials}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTrials((t) => Math.min(10, t + 1))}
                    aria-label="Increase trials"
                    style={{
                      width: 28,
                      height: 28,
                      background: 'var(--bg-overlay)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                      fontSize: 16,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                  >
                    +
                  </button>
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    letterSpacing: '0.08em',
                    marginBottom: 8,
                  }}
                >
                  Max tool calls per turn
                </div>
                <input
                  type="number"
                  value={maxToolCallsPerTurn}
                  onChange={(e) => setMaxToolCallsPerTurn(Number(e.target.value))}
                  min={1}
                  style={{
                    width: 80,
                    background: 'var(--bg-overlay)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    borderRadius: '6px',
                    padding: 8,
                    fontSize: 13,
                  }}
                />
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    marginTop: 6,
                    maxWidth: 160,
                    lineHeight: 1.4,
                  }}
                >
                  Higher = the agent can call more tools in a single turn before pausing.
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    letterSpacing: '0.08em',
                    marginBottom: 8,
                  }}
                >
                  Max identical tool calls
                </div>
                <input
                  type="number"
                  value={maxIdenticalToolCalls}
                  onChange={(e) => setMaxIdenticalToolCalls(Number(e.target.value))}
                  min={1}
                  style={{
                    width: 80,
                    background: 'var(--bg-overlay)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    borderRadius: '6px',
                    padding: 8,
                    fontSize: 13,
                  }}
                />
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    marginTop: 6,
                    maxWidth: 160,
                    lineHeight: 1.4,
                  }}
                >
                  How many times the same tool can be called in one turn before the run pauses.
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    letterSpacing: '0.08em',
                    marginBottom: 8,
                  }}
                >
                  Recovery attempts on loop
                </div>
                <input
                  type="number"
                  value={maxRecoveryAttempts}
                  onChange={(e) => setMaxRecoveryAttempts(Number(e.target.value))}
                  min={0}
                  style={{
                    width: 80,
                    background: 'var(--bg-overlay)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    borderRadius: '6px',
                    padding: 8,
                    fontSize: 13,
                  }}
                />
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    marginTop: 6,
                    maxWidth: 160,
                    lineHeight: 1.4,
                  }}
                >
                  When the agent gets stuck looping, how many times to reflect and try a different
                  approach before failing.
                </div>
              </div>
            </div>

            {/* Dangerous tool calls */}
            <div style={{ marginBottom: 16 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'var(--text-primary)',
                }}
              >
                <input
                  type="checkbox"
                  checked={allowDangerousToolCalls}
                  onChange={(e) => setAllowDangerousToolCalls(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Enable dangerous tool calls
              </label>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--warning)',
                  marginTop: 6,
                  lineHeight: 1.4,
                }}
              >
                Bypasses safety stops (e.g. repeated tool failures) so the goal keeps running. Use
                only when the goal matters more than the safety guard.
              </div>
            </div>

            {/* Run goal button */}
            <button
              type="button"
              onClick={handleRunGoal}
              style={{
                width: '100%',
                background: 'var(--info)',
                color: 'white',
                fontSize: 14,
                fontWeight: 500,
                padding: 12,
                borderRadius: '8px',
                border: 'none',
                cursor: 'pointer',
                marginTop: 16,
              }}
            >
              Run goal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
