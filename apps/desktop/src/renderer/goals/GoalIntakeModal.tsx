import { useEffect, useState } from 'react';

export interface GoalConfig {
  goalText: string;
  checks: Array<{ description: string }>;
  rubric: Array<{ description: string; weight: number }>;
  boundaries: string;
  costLimit: number;
  trials: number;
  maxToolCallsPerTurn: number;
  maxRecoveryAttempts: number;
  allowDangerousToolCalls: boolean;
}

interface GoalIntakeModalProps {
  open: boolean;
  onClose: () => void;
  userMessage: string;
  restatedGoal: string;
  onQuickStart: (goalText: string) => void;
  onConfiguredRun: (config: GoalConfig) => void;
}

interface Criterion {
  id: string;
  type: 'check' | 'rubric';
  description: string;
  weight: number;
}

const labelStyle = {
  fontSize: 12,
  fontWeight: 500,
  textTransform: 'uppercase' as const,
  color: 'var(--text-secondary)',
  letterSpacing: '0.08em',
  marginBottom: 8,
};

const inputStyle = {
  background: 'var(--bg-overlay)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
  borderRadius: 'var(--radius-sm)',
  padding: 8,
  fontSize: 13,
};

export function GoalIntakeModal({
  open,
  onClose,
  userMessage,
  restatedGoal,
  onQuickStart,
  onConfiguredRun,
}: GoalIntakeModalProps) {
  const [showForm, setShowForm] = useState(false);
  const [goalText, setGoalText] = useState(restatedGoal);
  const [criteria, setCriteria] = useState<Criterion[]>([
    { id: crypto.randomUUID(), type: 'check', description: '', weight: 50 },
  ]);
  const [boundaries, setBoundaries] = useState('');
  const [costLimit, setCostLimit] = useState(5);
  const [trials, setTrials] = useState(3);
  const [maxToolCallsPerTurn, setMaxToolCallsPerTurn] = useState(100);
  const [maxRecoveryAttempts, setMaxRecoveryAttempts] = useState(2);
  const [allowDangerousToolCalls, setAllowDangerousToolCalls] = useState(false);

  // Re-seed the editable goal whenever a fresh restated goal arrives.
  useEffect(() => {
    if (open) setGoalText(restatedGoal);
  }, [open, restatedGoal]);

  if (!open) return null;

  const trimmedGoal = goalText.trim();

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const addCriterion = () => {
    setCriteria((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: 'check', description: '', weight: 50 },
    ]);
  };

  const removeCriterion = (index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCriterion = (index: number, updates: Partial<Criterion>) => {
    setCriteria((prev) => prev.map((c, i) => (i === index ? { ...c, ...updates } : c)));
  };

  const handleRunGoal = () => {
    const checks = criteria
      .filter((c) => c.type === 'check' && c.description.trim())
      .map((c) => ({ description: c.description }));
    const rubric = criteria
      .filter((c) => c.type === 'rubric' && c.description.trim())
      .map((c) => ({ description: c.description, weight: c.weight }));
    onConfiguredRun({
      goalText: trimmedGoal,
      checks,
      rubric,
      boundaries,
      costLimit,
      trials,
      maxToolCallsPerTurn,
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
        background: 'var(--ethos-shadow-overlay)',
        zIndex: 1100,
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
          borderRadius: 'var(--radius-lg)',
          padding: 24,
          position: 'relative',
        }}
      >
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
            }}
          >
            ×
          </button>
        </div>

        {userMessage && (
          <div
            style={{
              background: 'var(--bg-overlay)',
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: 14,
              color: 'var(--text-primary)',
              marginBottom: 8,
            }}
          >
            {userMessage}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
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

        <textarea
          value={goalText}
          onChange={(e) => setGoalText(e.target.value)}
          placeholder="Describe the goal..."
          style={{
            ...inputStyle,
            width: '100%',
            minHeight: 56,
            resize: 'vertical',
            fontSize: 14,
            padding: 10,
            fontFamily: 'inherit',
            boxSizing: 'border-box',
            borderLeft: '3px solid var(--info)',
            marginBottom: 16,
          }}
        />

        <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => onQuickStart(trimmedGoal)}
            disabled={!trimmedGoal}
            style={{
              opacity: trimmedGoal ? 1 : 0.5,
              cursor: trimmedGoal ? 'pointer' : 'default',
              background: 'var(--info)',
              color: '#ffffff',
              fontSize: 14,
              fontWeight: 500,
              padding: '10px 20px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
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
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >
            Configure &amp; run
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
          Run now derives acceptance criteria automatically · 3 trials · cost capped by personality
          budget
        </div>

        {showForm && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={labelStyle}>Judging criteria</div>
              {criteria.map((c, i) => (
                <div
                  key={c.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}
                >
                  <select
                    value={c.type}
                    onChange={(e) =>
                      updateCriterion(i, { type: e.target.value as 'check' | 'rubric' })
                    }
                    style={inputStyle}
                  >
                    <option value="check">check</option>
                    <option value="rubric">rubric</option>
                  </select>
                  <input
                    type="text"
                    value={c.description}
                    onChange={(e) => updateCriterion(i, { description: e.target.value })}
                    placeholder="Description"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  {c.type === 'rubric' && (
                    <input
                      type="number"
                      value={c.weight}
                      onChange={(e) => updateCriterion(i, { weight: Number(e.target.value) })}
                      min={0}
                      max={100}
                      style={{ ...inputStyle, width: 60 }}
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
                    ×
                  </button>
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
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                + Add criterion
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={labelStyle}>Boundaries</div>
              <textarea
                value={boundaries}
                onChange={(e) => setBoundaries(e.target.value)}
                placeholder="e.g. Don't modify production data"
                style={{
                  ...inputStyle,
                  minHeight: 60,
                  resize: 'vertical',
                  width: '100%',
                  padding: 10,
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'flex-start',
                marginBottom: 16,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={labelStyle}>Cost limit</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>$</span>
                  <input
                    type="number"
                    value={costLimit}
                    onChange={(e) => setCostLimit(Number(e.target.value))}
                    min={0}
                    style={{ ...inputStyle, width: 80 }}
                  />
                </div>
              </div>
              <div>
                <div style={labelStyle}>Trials</div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => setTrials((t) => Math.max(1, t - 1))}
                    aria-label="Decrease trials"
                    style={{
                      width: 28,
                      height: 28,
                      background: 'var(--bg-overlay)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--text-primary)',
                      fontSize: 16,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                  >
                    −
                  </button>
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: 'var(--font-mono)',
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
                      borderRadius: 'var(--radius-sm)',
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
                <div style={labelStyle}>Max tool calls per turn</div>
                <input
                  type="number"
                  value={maxToolCallsPerTurn}
                  onChange={(e) => setMaxToolCallsPerTurn(Number(e.target.value))}
                  min={1}
                  style={{ ...inputStyle, width: 80 }}
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
                <div style={labelStyle}>Recovery attempts on loop</div>
                <input
                  type="number"
                  value={maxRecoveryAttempts}
                  onChange={(e) => setMaxRecoveryAttempts(Number(e.target.value))}
                  min={0}
                  style={{ ...inputStyle, width: 80 }}
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
              <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6, lineHeight: 1.4 }}>
                Bypasses safety stops (e.g. repeated tool failures) so the goal keeps running. Use
                only when the goal matters more than the safety guard.
              </div>
            </div>

            <button
              type="button"
              onClick={handleRunGoal}
              style={{
                width: '100%',
                background: 'var(--info)',
                color: '#ffffff',
                fontSize: 14,
                fontWeight: 500,
                padding: 12,
                borderRadius: 'var(--radius-md)',
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
