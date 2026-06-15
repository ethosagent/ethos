import { createEthosClient } from '@ethosagent/sdk';
import type { GoalAttemptWire, GoalEventWire, GoalWire } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { ExecutionGraph, type ToolResultData } from './ExecutionGraph';
import { GoalOutputModal } from './GoalOutputModal';
import {
  ACTIVE_STATUSES,
  formatDuration,
  formatTokens,
  statusConfig,
  TERMINAL_STATUSES,
} from './status';

interface GoalDetailViewProps {
  goalId: string;
  onBack: () => void;
  /** Called whenever the goal status may have changed so the list can refresh. */
  onChanged?: () => void;
}

export function GoalDetailView({ goalId, onBack, onChanged }: GoalDetailViewProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [goal, setGoal] = useState<GoalWire | null>(null);
  const [events, setEvents] = useState<GoalEventWire[]>([]);
  const [attempts, setAttempts] = useState<GoalAttemptWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [journeyOpen, setJourneyOpen] = useState(true);
  const [outputModalOpen, setOutputModalOpen] = useState(false);

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const load = useCallback(async () => {
    try {
      const res = await client.rpc.goals.get({ id: goalId });
      setGoal(res.goal);
      setEvents(res.events);
      setAttempts(res.attempts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load goal');
    } finally {
      setLoading(false);
    }
  }, [client, goalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isActive = goal ? ACTIVE_STATUSES.has(goal.status) : false;

  // Poll while the goal is active (web GoalDetail polls every 3s).
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(id);
  }, [isActive, load]);

  const fetchToolResult = useCallback(
    async (toolCallId: string): Promise<ToolResultData | null> => {
      try {
        return await client.rpc.goals.toolResult({ goalId, toolCallId });
      } catch {
        return null;
      }
    },
    [client, goalId],
  );

  const handleSteer = useCallback(async () => {
    const message = steerText.trim();
    if (!message) return;
    setSteering(true);
    try {
      await client.rpc.goals.steer({ id: goalId, message });
      setSteerText('');
      await load();
    } catch {
      // best-effort
    } finally {
      setSteering(false);
    }
  }, [client, goalId, steerText, load]);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await client.rpc.goals.cancel({ id: goalId });
      await load();
      onChangedRef.current?.();
    } catch {
      // best-effort
    } finally {
      setCancelling(false);
    }
  }, [client, goalId, load]);

  const handleResume = useCallback(async () => {
    setResuming(true);
    try {
      await client.rpc.goals.resume({ id: goalId });
      await load();
      onChangedRef.current?.();
    } catch {
      // best-effort
    } finally {
      setResuming(false);
    }
  }, [client, goalId, load]);

  const latestAttempt = useMemo(() => {
    if (attempts.length === 0) return null;
    return attempts.reduce((a, b) => (a.n > b.n ? a : b));
  }, [attempts]);

  const journeyEvents = useMemo(() => events.filter((e) => e.eventType !== 'usage'), [events]);

  if (loading) {
    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          height: 300,
          color: 'var(--text-tertiary)',
        }}
      >
        Loading…
      </div>
    );
  }

  if (error || !goal) {
    return (
      <div style={{ padding: '24px 32px' }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            fontSize: 13,
            padding: 0,
            marginBottom: 12,
          }}
        >
          ← Goals
        </button>
        <div style={{ color: 'var(--error)', fontSize: 14 }}>
          {error ? `Failed to load goal: ${error}` : 'Goal not found'}
        </div>
      </div>
    );
  }

  const isTerminal = TERMINAL_STATUSES.has(goal.status);
  const isLimitHit = goal.status === 'interrupted' && /limit/i.test(goal.errorText ?? '');
  const isCompleted = goal.status === 'completed';
  const hasFullAnalysis = isCompleted && !!goal.outputMd;
  const outputHeading = goal.status === 'failed' ? 'FAILURE' : 'OUTPUT';
  const bodyText = isCompleted
    ? goal.outputMd || goal.outputPartial || '(no output)'
    : goal.outputPartial?.trim()
      ? goal.outputPartial
      : '(no output)';
  const cfg = isLimitHit
    ? { color: 'var(--warning)', label: 'Limit hit', icon: '✗' }
    : statusConfig(goal.status);

  const verdict = latestAttempt?.verdict;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 32px',
          borderBottom: '1px solid var(--border-subtle)',
          gap: 16,
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <button
              type="button"
              onClick={onBack}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                padding: 0,
                fontSize: 13,
              }}
            >
              Goals
            </button>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>/</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              GOAL
            </span>
          </div>
          <h1
            style={{
              fontSize: 16,
              fontWeight: 500,
              margin: 0,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {goal.title || goal.goalText}
          </h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {attempts.length > 0 && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              Attempt {latestAttempt?.n ?? 1} of {goal.maxAttempts}
              {verdict != null && (
                <span style={{ marginLeft: 6 }}>· {Math.round(verdict.score * 100)}%</span>
              )}
            </span>
          )}

          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 12px',
              borderRadius: 'var(--radius-full)',
              fontSize: 12,
              fontWeight: 500,
              color: cfg.color,
              background: `color-mix(in srgb, ${cfg.color} 15%, transparent)`,
            }}
          >
            {isActive ? (
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: cfg.color,
                  animation: 'goals-pulse 1.5s ease-in-out infinite',
                }}
              />
            ) : (
              <span>{cfg.icon}</span>
            )}
            {cfg.label}
          </span>

          {isActive && (
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={cancelling}
              style={{
                height: 28,
                padding: '0 12px',
                background: 'none',
                border: '1px solid var(--error)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--error)',
                fontSize: 13,
                cursor: cancelling ? 'default' : 'pointer',
                opacity: cancelling ? 0.6 : 1,
              }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {(goal.status === 'failed' ||
            goal.status === 'cancelled' ||
            goal.status === 'interrupted') && (
            <button
              type="button"
              onClick={() => void handleResume()}
              disabled={resuming}
              style={{
                height: 28,
                padding: '0 12px',
                background: 'var(--info)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                color: '#ffffff',
                fontSize: 13,
                fontWeight: 500,
                cursor: resuming ? 'default' : 'pointer',
                opacity: resuming ? 0.6 : 1,
              }}
            >
              {resuming ? 'Resuming…' : 'Resume'}
            </button>
          )}
        </div>
      </div>

      {/* Scrollable middle */}
      <div
        style={{
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
        }}
      >
        {isTerminal && (
          <div style={{ padding: '24px 32px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: goal.status === 'failed' ? 'var(--error)' : 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                {outputHeading}
              </span>
              {goal.completedAt && (
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  · {formatDuration(goal.startedAt, goal.completedAt)} elapsed
                </span>
              )}
              {hasFullAnalysis && (
                <button
                  type="button"
                  onClick={() => setOutputModalOpen(true)}
                  style={{
                    marginLeft: 'auto',
                    background: 'none',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    padding: '4px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Full Analysis
                </button>
              )}
            </div>

            {goal.errorText && (
              <div
                style={{
                  padding: '10px 14px',
                  marginBottom: 16,
                  borderRadius: 'var(--radius-md)',
                  background: 'color-mix(in srgb, var(--error) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--error) 20%, transparent)',
                  color: 'var(--error)',
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {goal.errorText}
              </div>
            )}

            {!isCompleted && goal.outputPartial && (
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginBottom: 6,
                }}
              >
                Partial output
              </div>
            )}

            <div style={{ display: 'flex', gap: 24 }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '16px 20px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-elevated)',
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 500,
                  overflowY: 'auto',
                }}
              >
                {bodyText}
              </div>

              {verdict && (
                <div style={{ width: 220, flexShrink: 0 }}>
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        color: 'var(--text-tertiary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        marginBottom: 8,
                      }}
                    >
                      Judge Verdict
                    </div>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 600,
                        color: verdict.score >= 0.8 ? 'var(--success)' : 'var(--warning)',
                        marginBottom: 10,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {Math.round(verdict.score * 100)}%
                    </div>
                    {verdict.perCriterion.map((c) => {
                      const passed = c.pass || (c.score != null && c.score >= 0.8);
                      return (
                        <div
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 6,
                            marginBottom: 6,
                            fontSize: 12,
                            lineHeight: 1.4,
                          }}
                        >
                          <span
                            style={{
                              color: passed ? 'var(--success)' : 'var(--error)',
                              flexShrink: 0,
                              marginTop: 1,
                            }}
                          >
                            {passed ? '✓' : '✗'}
                          </span>
                          <span style={{ color: 'var(--text-secondary)' }}>{c.evidence}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Journey */}
        <div
          style={{
            padding: '0 32px 32px 32px',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <button
            type="button"
            onClick={() => setJourneyOpen((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 0',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-primary)',
              width: '100%',
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              JOURNEY
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Execution trace</span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: 'var(--text-tertiary)',
                transform: journeyOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 180ms var(--ease)',
              }}
            >
              ▸
            </span>
          </button>

          {journeyOpen && (
            <div style={{ flex: 1, minHeight: 360 }}>
              <ExecutionGraph
                events={journeyEvents}
                goalText={goal.goalText}
                personalityId={goal.personalityId}
                isActive={isActive}
                fetchToolResult={fetchToolResult}
              />
            </div>
          )}
        </div>
      </div>

      {/* Steer composer (active only) */}
      {isActive && (
        <div style={{ padding: '0 32px', marginBottom: 16, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              placeholder="Steer this goal — add context or redirect..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSteer();
              }}
              style={{
                flex: 1,
                background: 'var(--bg-overlay)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => void handleSteer()}
              disabled={steering || !steerText.trim()}
              style={{
                height: 32,
                padding: '0 16px',
                background: steerText.trim() ? 'var(--info)' : 'var(--bg-overlay)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                color: steerText.trim() ? '#ffffff' : 'var(--text-tertiary)',
                fontSize: 13,
                fontWeight: 500,
                cursor: steerText.trim() && !steering ? 'pointer' : 'default',
                opacity: steering ? 0.6 : 1,
              }}
            >
              Steer
            </button>
          </div>
        </div>
      )}

      {/* Stats footer */}
      <div
        style={{
          padding: '12px 32px',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-tertiary)',
          fontVariantNumeric: 'tabular-nums',
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <span>{goal.turnCount ?? 0} turns</span>
        <span>·</span>
        <span>{goal.toolCount ?? 0} tool calls</span>
        <span>·</span>
        <span>{formatTokens(goal.tokenCount)} tokens</span>
        <span>·</span>
        <span>{goal.costUsd != null ? `$${goal.costUsd.toFixed(2)}` : '$0.00'}</span>
        <span>·</span>
        <span>{formatDuration(goal.startedAt, goal.completedAt)} elapsed</span>
      </div>

      {hasFullAnalysis && (
        <GoalOutputModal
          open={outputModalOpen}
          onClose={() => setOutputModalOpen(false)}
          title={goal.title || goal.goalText}
          personalityId={goal.personalityId}
          outputMd={goal.outputMd ?? ''}
        />
      )}

      <style>{`@keyframes goals-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}
