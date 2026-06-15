import { createEthosClient } from '@ethosagent/sdk';
import type { GoalWire } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { GoalCard } from './GoalCard';
import { GoalDetailView } from './GoalDetailView';
import { type GoalConfig, GoalIntakeModal } from './GoalIntakeModal';
import { ACTIVE_STATUSES } from './status';

const COLUMNS = '1fr 120px 110px 130px 80px 70px';

export function GoalsPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [goals, setGoals] = useState<GoalWire[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [personalities, setPersonalities] = useState<Array<{ id: string; name: string }>>([]);
  const [personalityId, setPersonalityId] = useState<string>('');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeText, setIntakeText] = useState('');

  const loadGoals = useCallback(async () => {
    try {
      const res = await client.rpc.goals.list({});
      setGoals(res.goals);
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    void loadGoals();
  }, [loadGoals]);

  // Poll the list while any goal is active so statuses stay fresh.
  const hasActive = useMemo(() => goals.some((g) => ACTIVE_STATUSES.has(g.status)), [goals]);
  useEffect(() => {
    if (!hasActive || selectedGoalId) return;
    const id = setInterval(() => {
      void loadGoals();
    }, 5000);
    return () => clearInterval(id);
  }, [hasActive, selectedGoalId, loadGoals]);

  useEffect(() => {
    let cancelled = false;
    void client.rpc.personalities
      .list({})
      .then((res) => {
        if (cancelled) return;
        const items = res.items.map((p: { id: string; name: string }) => ({
          id: p.id,
          name: p.name,
        }));
        setPersonalities(items);
        setPersonalityId((prev) => prev || items[0]?.id || '');
      })
      .catch(() => {
        // best-effort
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const openIntake = useCallback(() => {
    setIntakeText('');
    setIntakeOpen(true);
  }, []);

  const handleQuickStart = useCallback(
    async (goalText: string) => {
      if (!personalityId) return;
      setIntakeOpen(false);
      try {
        const { goal } = await client.rpc.goals.create({ personalityId, goalText });
        await loadGoals();
        setSelectedGoalId(goal.id);
      } catch {
        // best-effort
      }
    },
    [client, personalityId, loadGoals],
  );

  const handleConfiguredRun = useCallback(
    async (config: GoalConfig) => {
      if (!personalityId) return;
      setIntakeOpen(false);
      const goalText = config.boundaries.trim()
        ? `${config.goalText}\n\nBoundaries: ${config.boundaries.trim()}`
        : config.goalText;
      try {
        const { goal } = await client.rpc.goals.create({
          personalityId,
          goalText,
          acceptanceCriteria: { checks: config.checks, rubric: config.rubric },
          maxAttempts: config.trials,
          maxCostUsd: config.costLimit,
          maxToolCallsPerTurn: config.maxToolCallsPerTurn,
          maxRecoveryAttempts: config.maxRecoveryAttempts,
          allowDangerousToolCalls: config.allowDangerousToolCalls,
        });
        await loadGoals();
        setSelectedGoalId(goal.id);
      } catch {
        // best-effort
      }
    },
    [client, personalityId, loadGoals],
  );

  const sorted = useMemo(() => {
    return [...goals].sort((a, b) => {
      const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
      const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return b.startedAt - a.startedAt;
    });
  }, [goals]);

  if (selectedGoalId) {
    return (
      <GoalDetailView
        goalId={selectedGoalId}
        onBack={() => {
          setSelectedGoalId(null);
          void loadGoals();
        }}
        onChanged={() => void loadGoals()}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 40,
          padding: '0 16px',
          flexShrink: 0,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
          Goals
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {goals.length} {goals.length === 1 ? 'goal' : 'goals'}
          </span>
          {personalities.length > 0 && (
            <select
              value={personalityId}
              onChange={(e) => setPersonalityId(e.target.value)}
              aria-label="Goal personality"
              style={{
                height: 28,
                background: 'var(--bg-overlay)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                fontSize: 13,
                padding: '0 8px',
              }}
            >
              {personalities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={openIntake}
            disabled={!personalityId}
            style={{
              height: 28,
              padding: '0 12px',
              background: 'none',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              cursor: personalityId ? 'pointer' : 'default',
              fontSize: 13,
              color: 'var(--text-secondary)',
              opacity: personalityId ? 1 : 0.5,
            }}
          >
            New goal
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
        {sorted.length === 0 ? (
          <div
            style={{
              marginTop: 24,
              padding: '48px 24px',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              fontSize: 14,
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-elevated)',
            }}
          >
            No goals yet — start one with New goal, or use Send as Goal in a chat
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: COLUMNS,
                padding: '8px 16px',
                background: 'var(--bg-elevated)',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              <span>Goal</span>
              <span>Personality</span>
              <span>Status</span>
              <span>Started</span>
              <span>Duration</span>
              <span style={{ textAlign: 'right' }}>Cost</span>
            </div>
            {sorted.map((goal) => (
              <GoalCard key={goal.id} goal={goal} selected={false} onSelect={setSelectedGoalId} />
            ))}
          </div>
        )}
      </div>

      <GoalIntakeModal
        open={intakeOpen}
        onClose={() => setIntakeOpen(false)}
        userMessage={intakeText}
        restatedGoal={intakeText}
        onQuickStart={(g) => void handleQuickStart(g)}
        onConfiguredRun={(c) => void handleConfiguredRun(c)}
      />

      <style>{`@keyframes goals-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}
