import type { ReactNode } from 'react';
import { z } from 'zod';

// `GoalWire.acceptanceCriteria` is `unknown` on the wire (legacy rows predate
// any shape), so the checks are read with a safeParse and anything that does
// not match renders nothing rather than guessing.
const ChecksSchema = z.object({
  checks: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      command: z.string().optional(),
    }),
  ),
});

export type GoalCheckView = z.infer<typeof ChecksSchema>['checks'][number];

export function parseGoalChecks(acceptanceCriteria: unknown): GoalCheckView[] {
  const parsed = ChecksSchema.safeParse(acceptanceCriteria);
  return parsed.success ? parsed.data.checks : [];
}

/**
 * The goal's acceptance checks, as captured at intake. A check with a
 * `command` shows it verbatim in mono — that command runs in the personality's
 * shell when the goal is judged, so the operator must be able to read exactly what it is.
 */
export function GoalChecks({ acceptanceCriteria }: { acceptanceCriteria: unknown }): ReactNode {
  const checks = parseGoalChecks(acceptanceCriteria);
  if (checks.length === 0) return null;
  return (
    <div style={{ padding: '16px 32px 0 32px' }}>
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
        Checks
      </div>
      {checks.map((c) => (
        <div key={c.id} style={{ marginBottom: 6, fontSize: 13, lineHeight: 1.4 }}>
          <div style={{ color: 'var(--text-secondary)' }}>{c.description}</div>
          {c.command ? (
            <div
              title="Runs in the personality's shell when the goal is judged; passes if it exits 0"
              style={{
                fontFamily: "'Geist Mono', monospace",
                fontSize: 12,
                color: 'var(--text-tertiary)',
                wordBreak: 'break-all',
              }}
            >
              $ {c.command}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
